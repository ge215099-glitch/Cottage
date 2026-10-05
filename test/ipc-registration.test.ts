/**
 * IPC 通道「声明 ↔ handler」完整性测试。
 *
 * 守的是一类**只有把 Electron 真正拉起来才会暴露**的错误：`INVOKE` 里声明了某个通道，
 * 但 `src/main/ipc/index.ts` 忘了给它注册 handler。
 *
 * 为什么需要这个测试（而不是只靠 `registerIpc` 里那道断言）：
 * `registerIpc` 的断言确实会抛错，但它要在**真实的 Electron 主进程**里才会执行，
 * 而 Electron 在受限环境下可能根本起不来。于是出现过这样的组合：
 * 406 个测试全绿、构建全过，而应用一启动就抛
 * 「以下 IPC 通道已登记在 INVOKE 里但没有 handler：export:character-card」直接退出。
 *
 * 所以这里做一次**静态**比对，把这条不变量提前到单元测试层。它证明的是
 * "两张表对得上"，不证明 handler 行为正确——那由运行时断言和各服务的测试负责。
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ALL_INVOKE_CHANNELS, INVOKE } from '../src/shared/ipc.js';
import { listCharactersInputSchema } from '../src/shared/schemas.js';

// vitest 以项目根为 cwd 运行；两个文件都必须读到，读不到要立刻炸（否则断言会空转假绿）
const repoRoot = process.cwd();
const contractFile = path.join(repoRoot, 'src/shared/ipc.ts');
const mainIpcFile = path.join(repoRoot, 'src/main/ipc/index.ts');
const preloadFile = path.join(repoRoot, 'src/preload/index.ts');
for (const file of [contractFile, mainIpcFile, preloadFile]) {
  if (!existsSync(file)) throw new Error(`测试无法定位源码文件：${file}`);
}
const ipcContractSource = readFileSync(contractFile, 'utf8');
const ipcMainSource = readFileSync(mainIpcFile, 'utf8');
const preloadSource = readFileSync(preloadFile, 'utf8');

// 两个 describe 都要用，所以在模块作用域解析一次
const declared = declaredChannels(ipcContractSource);
const registered = registeredKeys(ipcMainSource);

/** 从 `export const INVOKE = { ... } as const` 里取出键 → 通道名。 */
function declaredChannels(source: string): Map<string, string> {
  const block = /export const INVOKE = \{([\s\S]*?)\n\} as const;/.exec(source);
  if (!block) throw new Error('没能从 src/shared/ipc.ts 里找到 INVOKE 常量块');

  const entries = new Map<string, string>();
  // 只认缩进两格的 `key: 'value',`，注释行（/* 、 * ）天然不匹配。
  // 键名允许下划线开头：这样"多写一个键"会被下面第一条断言直接点名，
  // 而不是只落进"解析结果与运行时不一致"这种间接报错里。
  for (const m of block[1]!.matchAll(/^ {2}([A-Za-z_][A-Za-z0-9_]*): '([^']+)',$/gm)) {
    entries.set(m[1]!, m[2]!);
  }
  return entries;
}

/** 从主进程取出 `handlers.set(INVOKE.<key>, ...)` 里注册过的键。 */
function registeredKeys(source: string): Set<string> {
  const keys = new Set<string>();
  for (const m of source.matchAll(/handlers\.set\(\s*INVOKE\.([A-Za-z0-9]+)\s*,/g)) {
    keys.add(m[1]!);
  }
  return keys;
}

describe('IPC 通道声明与 handler 注册', () => {
  it('源码解析本身是有效的（否则下面的断言会变成空转）', () => {
    // 解析失败时必须炸，否则"两边都空"会让测试假绿。
    expect(declared.size).toBeGreaterThan(40);
    expect(registered.size).toBeGreaterThan(40);
    expect(INVOKE.messagesSend).toBe('messages:send');
    expect(INVOKE.charactersExport).toBe('characters:export');
  });

  it('每个声明过的通道都有 handler（这条就是漏写 handler 的拦截网）', () => {
    const missing = [...declared.keys()].filter((key) => !registered.has(key));
    expect(
      missing,
      `这些通道在 INVOKE 里声明了但没有 handler，主进程启动时会直接抛错：\n` +
        missing.map((k) => `  - INVOKE.${k} = '${declared.get(k)}'`).join('\n'),
    ).toEqual([]);
  });

  it('每个 handler 都用了声明过的通道名（防止改名后留下孤儿 handler）', () => {
    const extra = [...registered].filter((key) => !declared.has(key));
    expect(
      extra,
      `这些 handler 用了未声明的通道键，主进程启动时也会抛错：\n` +
        extra.map((k) => `  - INVOKE.${k}`).join('\n'),
    ).toEqual([]);
  });

  it('静态比对结果与运行时可用的通道清单一致', () => {
    // INVOKE 的键集合（源码解析）必须与运行时导出对象一致，
    // 否则说明解析漏了条目，上面的断言就有盲区。
    expect([...declared.values()].sort()).toEqual([...Object.values(INVOKE)].sort());
    expect([...declared.values()].sort()).toEqual([...ALL_INVOKE_CHANNELS].sort());
  });

  it('角色卡导出走 characters:export，export: 域不含角色卡（技术方案 6.2 的域划分）', () => {
    // 回归锚点：曾经这里多了一个 export:character-card，既没有 handler 也没有调用方，
    // 却因为"启动时通道齐全"断言把整个应用挡在启动之外。
    expect(INVOKE.charactersExport).toBe('characters:export');
    expect(declared.has('exportCharacterCard')).toBe(false);
    expect([...declared.values()].filter((c) => c.startsWith('export:'))).toEqual([
      'export:conversation-markdown',
      'export:conversation-json',
      'export:plain-config',
    ]);
  });
});

/**
 * 入参在 preload ↔ main 之间的空值约定。
 *
 * 这一组守的是"preload 发得出去、main 收得下来"。通道名对得上不代表参数对得上：
 * preload 里 `invoke(INVOKE.x, arg ?? null)` 会把"没传"变成 `null` 送过去，
 * 而 zod 的 `.optional()` 只接受 `undefined`——两边各自都"没错"，合起来就是坏功能。
 */
describe('IPC 可选入参的空值约定', () => {
  it('characters.list 的三种"不筛选"写法都被接受', () => {
    // 回归锚点：只写 .optional() 时 `characters.list()` 必定校验失败，
    // 角色库**永远**显示"还没有角色卡"，而标签筛选正常——实测踩过。
    expect(listCharactersInputSchema.safeParse(null).success).toBe(true);
    expect(listCharactersInputSchema.safeParse(undefined).success).toBe(true);
    expect(listCharactersInputSchema.safeParse({}).success).toBe(true);
    expect(listCharactersInputSchema.safeParse({ search: '林', favoriteOnly: true }).success).toBe(
      true,
    );
  });

  it('容忍 null 不等于放行一切：真正非法的查询仍然拒绝', () => {
    expect(listCharactersInputSchema.safeParse(42).success).toBe(false);
    expect(listCharactersInputSchema.safeParse('林').success).toBe(false);
    expect(listCharactersInputSchema.safeParse({ favoriteOnly: 'yes' }).success).toBe(false);
    expect(listCharactersInputSchema.safeParse({ tags: 'x' }).success).toBe(false);
    expect(listCharactersInputSchema.safeParse({ search: 'x'.repeat(201) }).success).toBe(false);
  });

  it('preload 每次用 `?? null` 发可选参数，主进程那侧都必须有对应 handler', () => {
    // 把所有这类通道列出来，避免"新增了一个 ?? null 但主进程没接"再次发生。
    // 目前有两处：characters.list（曾出问题）与 conversations.restart（一直用 .nullable()）。
    const nullishKeys = [...preloadSource.matchAll(/INVOKE\.([A-Za-z0-9_]+),\s*[^)]*?\?\?\s*null/g)]
      .map((m) => m[1]!);
    expect(nullishKeys.sort()).toEqual(['charactersList', 'conversationsRestart']);
    for (const key of nullishKeys) {
      expect(registered.has(key), `preload 用 ?? null 发送 INVOKE.${key}，主进程却没有 handler`).toBe(
        true,
      );
    }
  });
});
