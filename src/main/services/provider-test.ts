/**
 * 连接测试与模型拉取（产品设计文档 3.1）。
 *
 * **分派策略**——不假设所有端点都有 `/v1/models`：
 *   - OpenAI 兼容：优先 `GET /v1/models`；失败则降级为一次 1-token 的
 *     `chat/completions` 探针。
 *   - Anthropic：`POST /v1/messages` 最小请求。
 *
 * 结果分三态：可达 + 鉴权通过 / 可达 + 鉴权失败 / 不可达，
 * 并显示 HTTP 状态与**经过脱敏的**原始错误摘要（上游有时会把 Key 回显在错误里）。
 */
import {
  buildOpenAiModelsRequest,
  buildProbeRequest,
  type RequestPlan,
} from '@core/providers/request.js';
import { normalizeFetchError, normalizeHttpError, summarizeUpstreamBody } from '@core/providers/errors.js';
import type { ProviderTestResult } from '@shared/types.js';
import { decryptSecret, getStorageStatus } from '../secrets/index.js';
import type { AppContext } from '../context.js';
import { getProviderSecretForMain } from '../db/dao/providers.js';

export class ProviderTestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderTestError';
  }
}

export interface TestOptions {
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 读取被测试 provider 的明文 Key（只在本函数的调用栈里存活）。 */
async function readApiKey(ctx: AppContext, providerId: string): Promise<string> {
  const secret = getProviderSecretForMain(ctx.db, providerId);
  if (!secret) throw new ProviderTestError('Provider 不存在');
  if (!secret.apiKeyEnc) throw new ProviderTestError('还没有填写 API Key');
  const { plain } = await decryptSecret(secret.apiKeyEnc);
  return plain;
}

/**
 * 对一个 provider 做连接测试。
 *
 * 这个函数**不抛异常**用于表达"测试失败"——失败是正常结果，用 `outcome` 表达；
 * 只有"连 provider 都找不到 / Key 解不开"这类调用方错误才抛。
 */
export async function testProvider(
  ctx: AppContext,
  providerId: string,
  options: TestOptions = {},
): Promise<ProviderTestResult> {
  const secret = getProviderSecretForMain(ctx.db, providerId);
  if (!secret) throw new ProviderTestError('Provider 不存在');

  const storage = getStorageStatus();
  const storageWarning = storage.warning;

  let apiKey: string;
  try {
    apiKey = await readApiKey(ctx, providerId);
  } catch (err) {
    return {
      outcome: 'auth-failed',
      httpStatus: null,
      probe: secret.type === 'anthropic' ? 'messages' : 'chat-completions',
      message: err instanceof Error ? err.message : '无法读取已保存的 Key',
      models: [],
      storageWarning,
    };
  }

  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;

  /** 单次 HTTP 调用：返回状态与正文，异常转成 UNREACHABLE。 */
  const call = async (
    plan: RequestPlan,
  ): Promise<{ ok: true; status: number; body: string } | { ok: false; message: string; httpStatus: number | null }> => {
    try {
      const response = await doFetch(plan.url, {
        method: plan.method,
        headers: plan.headers,
        ...(plan.body ? { body: JSON.stringify(plan.body) } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await response.text().catch(() => '');
      return { ok: true, status: response.status, body };
    } catch (err) {
      const normalized = normalizeFetchError(err, '连接测试失败');
      return { ok: false, message: normalized.message, httpStatus: null };
    }
  };

  /* ---- Anthropic：直接打 /v1/messages ---- */
  if (secret.type === 'anthropic') {
    const plan = buildProbeRequest({
      providerType: 'anthropic',
      baseUrl: secret.baseUrl,
      apiKey,
      model: secret.defaultModel || secret.models[0] || '',
    });
    const result = await call(plan);
    if (!result.ok) {
      return {
        outcome: 'unreachable',
        httpStatus: null,
        probe: 'messages',
        message: result.message,
        models: [],
        storageWarning,
      };
    }
    return interpret(result.status, result.body, 'messages', [], storageWarning);
  }

  /* ---- OpenAI 兼容：先试 GET /v1/models，失败再降级探针 ---- */
  const modelsPlan = buildOpenAiModelsRequest({ baseUrl: secret.baseUrl, apiKey });
  const modelsResult = await call(modelsPlan);

  if (modelsResult.ok && modelsResult.status >= 200 && modelsResult.status < 300) {
    const models = extractModelIds(modelsResult.body);
    // 拿到了模型列表就顺便回填：这正是"从端点拉取模型"想做的事
    return {
      outcome: 'ok',
      httpStatus: modelsResult.status,
      probe: 'models',
      message: models.length ? `可达，鉴权通过，发现 ${models.length} 个模型` : '可达，鉴权通过',
      models,
      storageWarning,
    };
  }

  // /models 不通（404/405 很常见）或鉴权失败：都不直接下结论，改用探针再判一次
  const probePlan = buildProbeRequest({
    providerType: 'openai',
    baseUrl: secret.baseUrl,
    apiKey,
    model: secret.defaultModel || secret.models[0] || '',
  });
  const probeResult = await call(probePlan);

  if (!probeResult.ok) {
    // 两条路都不通才敢说不可达
    return {
      outcome: 'unreachable',
      httpStatus: null,
      probe: 'chat-completions',
      message: probeResult.message,
      models: [],
      storageWarning,
    };
  }

  // 探针成功时也可以把 /models 的报告作为补充信息丢掉，只如实报结果
  const interpreted = interpret(probeResult.status, probeResult.body, 'chat-completions', [], storageWarning);

  // 如果 /models 那次已经能看出鉴权明确失败，而探针也失败，interpret 已经给出 auth-failed；
  // 这里额外把"两个端点都 404"这种情况说清楚，避免用户以为是 Key 的问题。
  if (
    interpreted.outcome !== 'ok' &&
    modelsResult.ok &&
    (modelsResult.status === 404 || modelsResult.status === 405)
  ) {
    return {
      ...interpreted,
      message: `${interpreted.message}（该端点未实现 /v1/models，已改用 chat/completions 探针）`,
    };
  }
  return interpreted;
}

/** 把 HTTP 结果翻译成三态。 */
function interpret(
  status: number,
  body: string,
  probe: ProviderTestResult['probe'],
  models: string[],
  storageWarning: string | null,
): ProviderTestResult {
  if (status >= 200 && status < 300) {
    return {
      outcome: 'ok',
      httpStatus: status,
      probe,
      message: '可达，鉴权通过',
      models,
      storageWarning,
    };
  }
  const normalized = normalizeHttpError(status, body, '');
  // 401/403 → 可达但鉴权失败；其余非 2xx 也归到可达（拿到了 HTTP 响应）但请求被拒
  const outcome = normalized.code === 'AUTH_FAILED' ? 'auth-failed' : 'auth-failed';
  return {
    outcome,
    httpStatus: status,
    probe,
    message: `${normalized.message}`,
    models,
    storageWarning,
  };
}

/** 从 `/v1/models` 的响应里抽出 id 列表；格式不合规时返回空数组而不是抛错。 */
export function extractModelIds(body: string): string[] {
  try {
    const parsed = JSON.parse(body);
    const data = (parsed as { data?: unknown }).data;
    if (!Array.isArray(data)) return [];
    return data
      .map((item) => (item && typeof item === 'object' ? (item as { id?: unknown }).id : null))
      .filter((id): id is string => typeof id === 'string' && id.length > 0)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * 从端点拉取模型列表（设置页的"拉取模型"按钮）。
 *
 * Anthropic 没有等价的公开列表端点，因此明确返回空数组并给出说明——
 * 比伪造一个"猜出来的列表"更诚实。
 */
export async function fetchModelsFromProvider(
  ctx: AppContext,
  providerId: string,
  options: TestOptions = {},
): Promise<string[]> {
  const secret = getProviderSecretForMain(ctx.db, providerId);
  if (!secret) throw new ProviderTestError('Provider 不存在');
  if (secret.type === 'anthropic') return [];

  const apiKey = await readApiKey(ctx, providerId);
  const doFetch = options.fetchImpl ?? fetch;
  const plan = buildOpenAiModelsRequest({ baseUrl: secret.baseUrl, apiKey });

  try {
    const response = await doFetch(plan.url, {
      method: plan.method,
      headers: plan.headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const normalized = normalizeHttpError(response.status, body, '拉取模型失败');
      throw new ProviderTestError(normalized.message);
    }
    const body = await response.text();
    return extractModelIds(body);
  } catch (err) {
    if (err instanceof ProviderTestError) throw err;
    const normalized = normalizeFetchError(err, '拉取模型失败');
    throw new ProviderTestError(normalized.message);
  }
}

export { summarizeUpstreamBody };
