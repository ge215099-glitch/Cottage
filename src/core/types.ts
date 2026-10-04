/**
 * `src/core` 的公共类型。
 *
 * 本目录是**纯 TypeScript**：不得 import `electron`、不得 import 任何 `node:` 内置、
 * 不得做任何 IO、不得读取系统时间（时间一律由调用方作为入参传入）。
 * 这条约束让"Prompt 组装是纯函数"（docs/product-design.md 3.3）从团队自觉
 * 变成结构事实，见 docs/tech-stack.md 第 4.3 节与第 1.2 节不变量 I3。
 */

/** 角色卡（产品设计文档 3.2 的可编辑字段集合）。 */
export interface CharacterCard {
  /** 角色名，用于 `{{char}}` 替换与消息作者名 */
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

/** 用户人设，用于 `{{user}}` 替换。 */
export interface PersonaInfo {
  name: string;
  description?: string;
}

/** 一条待组装的历史消息。 */
export interface PromptMessage {
  /** 数据库主键，仅用于回填来源，不参与组装逻辑 */
  id: string;
  role: 'user' | 'assistant';
  content: string;
  archived: boolean;
  sortOrder: number;
}

/** 一条已生效的摘要（MVP 只有 level=1，见产品设计文档 3.4）。 */
export interface PromptSummary {
  id: string;
  content: string;
  coversFrom: number;
  coversTo: number;
  tokenCount: number;
  level: number;
}

/** 组装入参。**所有**外部状态都必须显式传入——包括"当前时间"。 */
export interface AssembleInput {
  character: CharacterCard;
  persona: PersonaInfo;
  summaries: PromptSummary[];
  messages: PromptMessage[];
  /** 用户新消息；为空表示只做预览（例如打开会话时） */
  userInput: string;
  /** 由调用方注入的当前时间戳（毫秒）。core 内不得自己取时间。 */
  nowMs: number;
  /** 日期/时间的展示时区偏移（分钟，东八区 = 480），默认 0（UTC） */
  timezoneOffsetMinutes?: number;
}

/** 组装分段标识（产品设计文档 3.3 的组装顺序）。 */
export type PromptSegmentKind =
  | 'system'
  | 'fewShot'
  | 'summary'
  | 'history'
  | 'postHistory'
  | 'user';

/** 组装结果的一个分段。token 明细逐段累加必须等于合计（验收项 4/8）。 */
export interface PromptSegment {
  kind: PromptSegmentKind;
  /** 该分段的纯文本（已做变量替换） */
  text: string;
  /** 归属的 wire 角色，仅作 preview 提示，不代表最终请求体 */
  role: 'system' | 'user' | 'assistant';
  /** 摘要分段的覆盖区间，仅 kind === 'summary' 时有值 */
  coversFrom?: number;
  coversTo?: number;
  /** 摘要分段的来源 message id */
  sourceId?: string;
}

/**
 * Provider 无关的中间表示（IR）。
 *
 * 组装只产出 IR；把它变成请求体是各适配器的职责（"统一组装 + 分派序列化"，
 * 产品设计文档 3.3 / 技术方案 7.3）。
 */
export interface PromptSpec {
  /** 逻辑分段，按组装顺序排列 */
  segments: PromptSegment[];
  /** 已做变量替换的元信息，供 UI 回显与排查 */
  meta: {
    characterName: string;
    userName: string;
    /** 参与组装的历史消息条数（不含归档） */
    historyCount: number;
    /** 参与组装的摘要段数 */
    summaryCount: number;
    /** 已归档、未参与组装的消息条数，供 UI 显示 */
    archivedCount: number;
  };
}

/** token 计数结果：**永远**带上"精确还是估算"（产品设计文档 3.3）。 */
export interface TokenCount {
  tokens: number;
  /** true = 精确（gpt-tokenizer），false = 估算 */
  exact: boolean;
  /** 计数方法标识，用于 UI 标注与排查 */
  method: string;
}

/** 分段 token 明细。求和约束由 `totalTokens` 保证。 */
export interface SegmentTokenDetail {
  kind: PromptSegmentKind;
  label: string;
  count: TokenCount;
  /** 该分段覆盖的条目数（历史=条数，摘要=段数），仅用于文案 */
  itemCount?: number;
}

export interface TokenBreakdown {
  segments: SegmentTokenDetail[];
  total: TokenCount;
  /** 模型上下文上限（由调用方给出） */
  limit: number;
  /** 占用比例，0–1，已按 limit 归一 */
  ratio: number;
  /** 是否至少有一项是估算（UI 需要显示"约"） */
  anyEstimated: boolean;
}
