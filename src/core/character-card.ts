/**
 * 角色卡导入 / 导出（产品设计文档 3.2）。
 *
 * 核心承诺（验收项 1）：
 *   **一张 v2/v3 角色卡导入后导出，除 Cottage 管理的字段外，其他字段与 `raw_json` 完全一致。**
 *
 * 实现方式就是"以 `raw_json` 为基底，只覆盖 Cottage 自己管理的字段"：
 * 不删任何第三方字段、不改嵌套层级，所以"不丢字段"是结构保证而不是测试运气。
 */

export type CardSpecVersion = 'v2' | 'v3' | 'unknown';

/** Cottage 能识别并管理的字段（导入时读取、导出时回写）。 */
export interface ParsedCharacterCard {
  specVersion: CardSpecVersion;
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  alternateGreetings: string[];
  mesExample: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  tags: string[];
  /** 原卡完全保留的 JSON（不含 Cottage 附加字段） */
  rawJson: Record<string, unknown>;
  /** Cottage 不管理、导出时会原样保留的顶层字段名 */
  preservedFields: string[];
}

/** Cottage 读写的顶层字段名。 */
const MANAGED_TOP_LEVEL = new Set([
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'alternate_greetings',
  'mes_example',
  'system_prompt',
  'post_history_instructions',
  'tags',
  'spec',
  'spec_version',
  'data',
  'extensions',
]);

/**
 * Cottage 读写的 `data` 内字段名（v2/v3 的核心字段都在 `data` 里）。
 *
 * **口径很重要**：这里的"管理"指"导出时会用 Cottage 的值回写"。
 * `creator_notes` / `character_version` / `character_book` / `assets` 这类字段
 * Cottage 既不读也不写，因此**不在**本集合内——它们属于"原样保留"，
 * 也就会出现在 `preservedFields` 里给用户看。
 */
const MANAGED_IN_DATA = new Set([
  'name',
  'description',
  'personality',
  'scenario',
  'first_mes',
  'alternate_greetings',
  'mes_example',
  'system_prompt',
  'post_history_instructions',
  'tags',
  'extensions',
]);

export class CharacterCardError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'CharacterCardError';
    this.reason = reason;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

/** 读取一个"可能是字符串数组"的字段；字符串按单元素数组处理。 */
function readStringArray(source: Record<string, unknown>, key: string): string[] {
  const value = source[key];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string');
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

/**
 * 解析角色卡 JSON。
 *
 * 兼容形态：
 *   - v2：`{ spec: 'chara_card_v2', data: { ... } }`
 *   - v3：`{ spec: 'chara_card_v3', data: { ... } }`（字段与 v2 同构，多若干可选字段）
 *   - 裸卡：顶层直接放 `name/description/...`（老格式，仍接受）
 *
 * @throws CharacterCardError 当输入不是对象、或拿不到非空 `name` 时
 */
export function parseCharacterCard(input: unknown): ParsedCharacterCard {
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      throw new CharacterCardError('invalid-json', '角色卡不是合法的 JSON 文本');
    }
  }
  if (!isRecord(input)) {
    throw new CharacterCardError('invalid-shape', '角色卡必须是一个 JSON 对象');
  }

  const specRaw = readString(input, 'spec') || readString(input, 'spec_version');
  const specVersion: CardSpecVersion =
    specRaw === 'chara_card_v2' ? 'v2' : specRaw === 'chara_card_v3' ? 'v3' : specRaw ? 'unknown' : 'unknown';

  // v2/v3 把字段放在 data 里；裸卡直接用顶层。
  const data = isRecord(input.data) ? input.data : null;
  const fields = data ?? input;

  const name = readString(fields, 'name').trim();
  if (!name) {
    throw new CharacterCardError('missing-name', '角色卡缺少 name 字段');
  }

  // rawJson 必须**原样**保留，因此对输入做一次深拷贝（不持有调用方引用）。
  const rawJson = deepClone(input) as Record<string, unknown>;

  return {
    specVersion,
    name,
    description: readString(fields, 'description'),
    personality: readString(fields, 'personality'),
    scenario: readString(fields, 'scenario'),
    firstMes: readString(fields, 'first_mes'),
    alternateGreetings: readStringArray(fields, 'alternate_greetings'),
    mesExample: readString(fields, 'mes_example'),
    systemPrompt: readString(fields, 'system_prompt'),
    postHistoryInstructions: readString(fields, 'post_history_instructions'),
    tags: readStringArray(fields, 'tags'),
    rawJson,
    preservedFields: collectPreservedFields(input, data),
  };
}

/** 原卡里 Cottage 不管理的顶层字段（导出时原样保留，这里只用于 UI 提示）。 */
function collectPreservedFields(
  root: Record<string, unknown>,
  data: Record<string, unknown> | null,
): string[] {
  const out: string[] = [];
  for (const key of Object.keys(root)) {
    if (!MANAGED_TOP_LEVEL.has(key)) out.push(key);
  }
  if (data) {
    for (const key of Object.keys(data)) {
      if (!MANAGED_IN_DATA.has(key)) out.push(`data.${key}`);
    }
  }
  return out;
}

function deepClone<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => deepClone(v)) as unknown as T;
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = deepClone(v);
    return out as T;
  }
  return value;
}

/** Cottage 侧的字段值（DAO 的 camelCase 视图）。 */
export interface CharacterFields {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  alternateGreetings: string[];
  mesExample: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  tags: string[];
}

export interface ExportOptions {
  /** 自定义头像：导出时内联到 `extensions.cottage.avatar`（相对路径或 data URL） */
  avatar?: string | null;
  /** Cottage 附加信息的写入位置，默认沿用原卡的 extensions 结构 */
  extensionsKey?: string;
}

/**
 * 导出角色卡。
 *
 * 规则：**以 `raw_json` 为基底，只覆盖 Cottage 管理的字段**（产品设计文档 3.2）。
 * 因此第三方字段（`creator_notes`、`character_book`、自定义顶层键…）全部无损。
 */
export function exportCharacterCard(
  rawJson: Record<string, unknown>,
  fields: CharacterFields,
  options: ExportOptions = {},
): Record<string, unknown> {
  const out = deepClone(rawJson);
  const hasData = isRecord(out.data);
  const target: Record<string, unknown> = hasData ? (out.data as Record<string, unknown>) : out;

  target.name = fields.name;
  target.description = fields.description;
  target.personality = fields.personality;
  target.scenario = fields.scenario;
  target.first_mes = fields.firstMes;
  target.alternate_greetings = [...fields.alternateGreetings];
  target.mes_example = fields.mesExample;
  target.system_prompt = fields.systemPrompt;
  target.post_history_instructions = fields.postHistoryInstructions;
  target.tags = [...fields.tags];

  if (hasData) {
    if (typeof out.spec !== 'string' || !out.spec) out.spec = 'chara_card_v2';
  }

  // Cottage 自己的扩展信息统一挂在 extensions.cottage 下，不污染第三方命名空间。
  if (options.avatar) {
    const key = options.extensionsKey ?? 'cottage';
    const existingExt = isRecord(target.extensions) ? (target.extensions as Record<string, unknown>) : {};
    const existingOwn = isRecord(existingExt[key]) ? (existingExt[key] as Record<string, unknown>) : {};
    existingExt[key] = { ...existingOwn, avatar: options.avatar };
    target.extensions = existingExt;
  }

  return out;
}

/**
 * PNG 文本块关键词（导出 PNG 卡时用）。
 *
 * 只有**明确写着** v3 的卡才写 `ccv3`：读侧是 `ccv3` 优先，如果给一张 v2 卡
 * 写了 `ccv3`，别人按 v3 去解析会拿不到该有的字段。其余一律 `chara`。
 */
export function cardTextChunkKeyword(card: Record<string, unknown>): 'ccv3' | 'chara' {
  const spec = readString(card, 'spec') || readString(card, 'spec_version');
  return spec === 'chara_card_v3' ? 'ccv3' : 'chara';
}

/**
 * 卡的名字：v2/v3 放在 `data.name`，裸卡放在顶层。
 *
 * 别写成只看顶层——那会让所有 v2/v3 卡都拿不到名字，导出时的默认文件名
 * 永远是兜底的 `character`（实测就是这么发现这个 bug 的：原生保存对话框里
 * 预填的是 `character.png`，而这张卡明明叫「林晚」）。
 */
export function cardDisplayName(card: Record<string, unknown>): string {
  const data = isRecord(card.data) ? card.data : null;
  return (data ? readString(data, 'name') : '') || readString(card, 'name');
}

/**
 * 无损校验：导出的卡是否保留了原卡的全部第三方字段。
 * 用于测试与"导入后立即导出"的自检。
 *
 * 判定口径：被 Cottage 管理的字段（`MANAGED_TOP_LEVEL` / `MANAGED_IN_DATA`）
 * 允许值变化；其余字段必须一字不差、层级不丢。
 */
export function findLostFields(
  rawJson: Record<string, unknown>,
  exported: Record<string, unknown>,
): string[] {
  const lost: string[] = [];

  const walk = (original: Record<string, unknown>, current: Record<string, unknown>, path: string): void => {
    for (const [key, value] of Object.entries(original)) {
      const childPath = path ? `${path}.${key}` : key;
      const managed = path === '' ? MANAGED_TOP_LEVEL.has(key) : MANAGED_IN_DATA.has(key);
      const now = current[key];

      // 被管理的**容器**（如 `data`、`extensions`）自身允许被改写，但必须继续下钻：
      // 它的子字段里仍可能有 Cottage 不管理的第三方字段，丢了就是丢数据。
      if (managed && !isRecord(value)) continue;

      if (isRecord(value)) {
        if (!isRecord(now)) {
          lost.push(childPath);
          continue;
        }
        walk(value, now, childPath);
        continue;
      }
      if (managed) continue;

      if (Array.isArray(value)) {
        if (!Array.isArray(now) || now.length !== value.length) lost.push(childPath);
        continue;
      }
      if (now !== value) lost.push(childPath);
    }
  };

  walk(rawJson, exported, '');
  return lost;
}
