/**
 * 密钥保护（产品设计文档 3.1，技术方案 6.4）。
 *
 * 硬规则，每条都有对应测试或结构保证：
 *   1. 明文只存在于主进程内存中的一次调用栈内；用完即释放引用，不缓存到长期变量。
 *   2. Linux 降级路径：`getSelectedStorageBackend()` 返回 `basic_text` 时说明本机
 *      无可用密钥环、Key **实际未受保护**，UI 必须显示警告。
 *   3. 明文永不进入日志、错误信息、导出文件的默认范围。
 *
 * 本模块是**唯一**知道密文形态的地方；DAO 只把它当不透明字符串存取。
 *
 * ---
 * 与设计文档的偏差（已核实，非疏漏）
 *
 * `docs/product-design.md` 3.1 要求"只用异步 API（`encryptStringAsync` /
 * `decryptStringAsync`），且必须在 app ready 之后调用"。核实结论：**Electron 并没有
 * 这两个 API**——`safeStorage` 只提供同步的 `encryptString` / `decryptString`，
 * 且没有 `shouldReEncrypt` 返回值。已逐一检查 electron 34 / 35 / 36 / 37 / 38 / 39
 * 的 `electron.d.ts`，六个版本都只有同步签名。
 *
 * 因此这里：
 *   - 用同步原语实现；
 *   - **对外仍然暴露 Promise**，这样将来 Electron 一旦补上异步 API，
 *     调用方（IPC handler）一行都不用改；
 *   - 把"密钥轮换后回写"改成**版本前缀**方案（见 `ENC_PREFIX`）：密文带 `v1:` 前缀，
 *     读到无前缀的历史数据时按旧格式解密并标记需要回写，等价于原本
 *     `shouldReEncrypt` 想要的效果。
 *
 * 同步调用是毫秒级的（本地密钥环一次系统调用），放在主进程事件循环上可接受；
 * 真正的耗时点是网络 IO，那个本来就在主进程里异步做。
 */
import { safeStorage } from 'electron';

/**
 * 密文前缀：用来区分"由本模块写入的密文"与历史数据/外部写坏的内容。
 * 更换算法时递增版本号，解密端按前缀分派。
 */
const ENC_PREFIX = 'v1:';

export interface StorageStatus {
  /** safeStorage 后端名；'basic_text' 表示密钥实际未受保护 */
  backend: string;
  /** 是否可用（不可用时连加密都做不了） */
  available: boolean;
  /** 非空时必须显著警告（产品设计文档 3.1） */
  warning: string | null;
}

/**
 * 查询当前平台的密钥存储状态。
 *
 * `getSelectedStorageBackend()` 只在 Linux 上有意义；其它平台返回的字符串
 * 也一并透出，便于诊断页展示。
 */
export function getStorageStatus(): StorageStatus {
  let backend = 'unknown';
  try {
    backend = safeStorage.getSelectedStorageBackend();
  } catch {
    // 非 Linux 或 API 不可用时保守处理
    backend = 'unknown';
  }

  const available = safeStorage.isEncryptionAvailable();
  if (!available) {
    return {
      backend,
      available: false,
      warning:
        '本机没有可用的系统密钥环，API Key 无法加密存储。为避免明文落库，保存密钥会被拒绝。',
    };
  }
  if (backend === 'basic_text') {
    return {
      backend,
      available: true,
      warning:
        '当前系统的密钥存储后端为 basic_text：本机没有可用的密钥环，API Key 实际未被保护，只做了编码而非加密。请勿在此机器上保存重要密钥。',
    };
  }
  return { backend, available: true, warning: null };
}

/**
 * 加密明文密钥。
 *
 * 返回带 `v1:` 前缀的密文，便于将来替换算法时做版本判别。
 *
 * @throws Error 当 safeStorage 不可用时——此时**宁可拒绝保存**也不能明文落库。
 */
export async function encryptSecret(plain: string): Promise<string> {
  const status = getStorageStatus();
  if (!status.available) {
    throw new Error('系统密钥存储不可用，已拒绝保存明文 Key');
  }
  const encrypted = safeStorage.encryptString(plain);
  return `${ENC_PREFIX}${encrypted.toString('base64')}`;
}

export interface DecryptResult {
  plain: string;
  /** 密文是旧格式（无版本前缀）时置真，调用方应回写为当前格式 */
  shouldReEncrypt: boolean;
}

/**
 * 解密密钥。
 *
 * 兼容处理：**没有 `v1:` 前缀的历史值**按"旧格式 base64 密文"尝试解密，
 * 这样早期版本写入的数据不会因为加了版本前缀就打不开；解出来的同时标记需要回写，
 * 于是下一次保存会顺手把它升级到带前缀的新格式。
 *
 * @throws Error 密文损坏或系统密钥环变更导致无法解密时
 */
export async function decryptSecret(encrypted: string): Promise<DecryptResult> {
  const status = getStorageStatus();
  if (!status.available) {
    throw new Error('系统密钥存储不可用，无法解密已保存的 Key');
  }

  const hasPrefix = encrypted.startsWith(ENC_PREFIX);
  const payload = hasPrefix ? encrypted.slice(ENC_PREFIX.length) : encrypted;

  let buffer: Buffer;
  try {
    buffer = Buffer.from(payload, 'base64');
  } catch {
    throw new Error('已保存的 Key 数据损坏，无法解密');
  }
  if (buffer.length === 0) {
    throw new Error('已保存的 Key 数据为空，无法解密');
  }

  let plain: string;
  try {
    plain = safeStorage.decryptString(buffer);
  } catch {
    // 不要把底层异常原文抛出去：它可能包含密文片段
    throw new Error('无法解密已保存的 Key（系统密钥环可能已变更，请重新填写）');
  }

  return { plain, shouldReEncrypt: !hasPrefix };
}

/**
 * 判断密文是否为空——供 DAO 侧决定 `hasKey`，不做解密，因此不会带出明文。
 */
export function hasStoredSecret(encrypted: string | null | undefined): boolean {
  return typeof encrypted === 'string' && encrypted.length > 0;
}
