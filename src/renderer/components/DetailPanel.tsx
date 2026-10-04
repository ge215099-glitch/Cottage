/**
 * 右侧详情栏（UI 文档第 3.2 节）。
 *
 * 四条硬规则：
 *   R1 不新增右栏专属入口：开关只在主区顶栏与输入区占用数字两处。
 *   R2 每个标签首屏尽量不滚动（上下文 ≈ 420px、对话 ≈ 360px、数据 ≈ 280px）。
 *   R3 压缩是状态机：空闲实心按钮 / 压缩中进度 + 可取消 / 失败错误条 + 重试。
 *   R4 固定宽度，只有展开与收起两态。
 */
import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import type { Character, Conversation, Persona, Provider, Summary, TokenPreview } from '@shared/types.js';
import { usePanelStore } from '../stores/panel.js';
import { useCompressStore, compressPercent } from '../stores/compress.js';

export interface DetailPanelProps {
  conversation: Conversation | null;
  character: Character | null;
  providers: Provider[];
  personas: Persona[];
  summaries: Summary[];
  preview: TokenPreview | null;
  /** 压缩候选条数与预计节省（由主进程预览算出） */
  compressCandidateCount: number;
  onCompress(): void;
  onCancelCompress(): void;
  onRestoreSummary(summaryId: string): void;
  onUpdateConversation(patch: {
    providerId?: string | null;
    model?: string;
    personaId?: string | null;
    params?: Partial<Conversation['params']>;
  }): void;
  onRestart(): void;
  onExport(kind: 'md' | 'json'): void;
  onCopyConversation(): void;
  onDeleteConversation(): void;
  onEditCharacter(): void;
}

const SEG_CLASS: Record<string, string> = {
  system: 'seg-system',
  fewShot: 'seg-fewshot',
  summary: 'seg-summary',
  history: 'seg-history',
  user: 'seg-input',
};

export function DetailPanel({
  conversation,
  character,
  providers,
  personas,
  summaries,
  preview,
  compressCandidateCount,
  onCompress,
  onCancelCompress,
  onRestoreSummary,
  onUpdateConversation,
  onRestart,
  onExport,
  onCopyConversation,
  onDeleteConversation,
  onEditCharacter,
}: DetailPanelProps): JSX.Element {
  const open = usePanelStore((s) => s.open);
  const tab = usePanelStore((s) => s.tab);
  const setTab = usePanelStore((s) => s.setTab);
  const scrollTo = usePanelStore((s) => s.scrollTo);
  const setScrollTo = usePanelStore((s) => s.setScrollTo);

  const bodyRef = useRef<HTMLDivElement | null>(null);

  // 「点击占用数字 → 打开右栏并滚到 token 明细」
  useEffect(() => {
    if (scrollTo !== 'tokens' || !bodyRef.current) return;
    bodyRef.current.scrollTop = 0;
    setScrollTo(null);
  }, [scrollTo, setScrollTo]);

  const compress = useCompressStore();
  const activeProvider = conversation?.providerId
    ? (providers.find((p) => p.id === conversation.providerId) ?? null)
    : null;

  return (
    <aside id="panel" className={open ? undefined : 'hidden'} aria-label="详情栏">
      <div className="tabs" role="tablist">
        {(
          [
            { key: 'context', label: '上下文' },
            { key: 'conversation', label: '对话' },
            { key: 'character', label: '角色' },
            { key: 'data', label: '数据' },
          ] as const
        ).map((item) => (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={tab === item.key}
            className={tab === item.key ? 'tab active' : 'tab'}
            onClick={() => setTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="panel-body" ref={bodyRef}>
        {!conversation ? (
          <div className="sub">选择一个对话查看详情</div>
        ) : tab === 'context' ? (
          <>
            {/* 自动压缩开关状态（点击跳到设置） */}
            <div className="panel-section">
              <div className="row-between">
                <span className="sub">自动压缩（80%）</span>
                <button
                  type="button"
                  className="btn"
                  style={{ height: 26 }}
                  onClick={() => setTab('conversation')}
                >
                  已开启 · 去设置
                </button>
              </div>
            </div>

            <ContextSection preview={preview} />

            {/* 压缩：状态机（R3） */}
            <div className="panel-section">
              {compress.status === 'running' ? (
                <>
                  <div className="btn primary" style={{ pointerEvents: 'none' }}>
                    {compress.phase === 'summarizing'
                      ? '摘要生成中…'
                      : `压缩中 ${compress.done}/${compress.total} 段…`}
                  </div>
                  <div className="compress-progress">
                    <div className="track">
                      <i style={{ width: `${compressPercent(compress)}%` }} />
                    </div>
                    <button type="button" className="btn block" onClick={onCancelCompress}>
                      取消压缩
                    </button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  className="btn primary"
                  disabled={compressCandidateCount < 4}
                  onClick={onCompress}
                >
                  {compressCandidateCount >= 4
                    ? `压缩最老的 ${Math.min(8, compressCandidateCount)} 条`
                    : '未归档历史不足 4 条'}
                </button>
              )}
              {compress.status === 'error' && compress.error ? (
                <div className="compress-error">
                  压缩失败：{compress.error.message}
                  <button
                    type="button"
                    style={{ color: 'inherit', textDecoration: 'underline', marginLeft: 8 }}
                    onClick={onCompress}
                  >
                    重试
                  </button>
                </div>
              ) : null}
              {compress.lastResult ? (
                <div className="compress-result">
                  {`已将第 ${compress.lastResult.from}–${compress.lastResult.to} 条压缩（${compress.lastResult.tokensBefore.toLocaleString('en-US')} → ${compress.lastResult.tokensAfter.toLocaleString('en-US')} tokens）`}
                </div>
              ) : null}
            </div>

            {/* 压缩历史：展开后每条右侧才出现「恢复」 */}
            <div className="panel-section">
              <div className="row-between">
                <h3>压缩历史 · {summaries.length} 段</h3>
              </div>
              <div className="sum-list">
                {summaries.length === 0 ? (
                  <div className="sub">还没有压缩过</div>
                ) : (
                  summaries.map((summary) => (
                    <div className="sum-item" key={summary.id}>
                      <span className="t">
                        第 {summary.coversFrom}–{summary.coversTo} 条
                      </span>
                      <span className="v">{summary.tokenCount.toLocaleString('en-US')} tok</span>
                      <button
                        type="button"
                        className="restore"
                        onClick={() => onRestoreSummary(summary.id)}
                      >
                        恢复
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>

            <ConsumptionSection conversation={conversation} />
          </>
        ) : tab === 'conversation' ? (
          <ConversationSection
            conversation={conversation}
            providers={providers}
            personas={personas}
            activeProvider={activeProvider}
            onUpdate={onUpdateConversation}
            onRestart={onRestart}
          />
        ) : tab === 'character' ? (
          <CharacterSection character={character} onEdit={onEditCharacter} />
        ) : (
          <DataSection
            conversation={conversation}
            summaries={summaries}
            onExport={onExport}
            onCopyConversation={onCopyConversation}
            onDeleteConversation={onDeleteConversation}
          />
        )}
      </div>
    </aside>
  );
}

/* ------------------------------------------------------------------ */
/* 上下文标签                                                          */
/* ------------------------------------------------------------------ */

function ContextSection({ preview }: { preview: TokenPreview | null }): JSX.Element {
  if (!preview) {
    return (
      <div className="panel-section">
        <h3>上下文占用</h3>
        <div className="sub">正在计算…</div>
      </div>
    );
  }

  const percent = preview.percent;
  const color = percent >= 80 ? 'var(--danger)' : percent >= 75 ? 'var(--warn)' : 'inherit';

  return (
    <>
      <div className="panel-section">
        <div className="row-between">
          <h3>上下文占用</h3>
          <span className="big-num" style={{ color }}>
            {percent}%
          </span>
        </div>
        <div className={percent >= 75 ? 'usage warn' : 'usage'}>
          {preview.segments.map((segment) => (
            <i
              key={segment.kind}
              className={SEG_CLASS[segment.kind] ?? 'seg-input'}
              style={{ width: `${(segment.tokens / preview.limit) * 100}%` }}
              title={`${segment.label}：${segment.tokens} tok`}
            />
          ))}
        </div>
        <div className="row-between">
          <span className="legend">
            {preview.total.toLocaleString('en-US')} / {preview.limit.toLocaleString('en-US')} tok
          </span>
          {/* 估算必须标「约」，不允许当精确展示 */}
          <span className="legend">{preview.anyEstimated ? '约（估算）' : '精确'}</span>
        </div>
      </div>

      <div className="panel-section" data-tokens="detail">
        <h3>明细</h3>
        <div className="detail-list">
          {preview.segments.map((segment) => (
            <div key={segment.kind}>
              <span className="k">
                {segment.label}
                {segment.itemCount > 1 ? `(${segment.itemCount})` : ''}
              </span>
              <span className="mini">
                <i
                  style={{
                    width: `${Math.min(100, (segment.tokens / Math.max(1, preview.total)) * 100).toFixed(0)}%`,
                  }}
                />
              </span>
              <span className="v">
                {segment.exact ? '' : '约 '}
                {segment.tokens.toLocaleString('en-US')}
              </span>
            </div>
          ))}
          <hr />
          <div>
            <span className="k">合计</span>
            <span className="v">{preview.total.toLocaleString('en-US')}</span>
          </div>
        </div>
      </div>
    </>
  );
}

/** 本次消耗：用时 / tokens / TTFT / 费用（费用需模型定价，MVP 只显示 token 与时长）。 */
function ConsumptionSection({ conversation }: { conversation: Conversation }): JSX.Element {
  return (
    <div className="panel-section">
      <h3>本次消耗</h3>
      <div className="kv">
        <span>消息</span>
        <span>{conversation.messageCount} 条</span>
      </div>
      <div className="kv">
        <span>摘要</span>
        <span>{conversation.summaryCount} 段</span>
      </div>
      <div className="kv">
        <span>更新时间</span>
        <span>{new Date(conversation.updatedAt).toLocaleString('zh-CN')}</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 对话标签                                                            */
/* ------------------------------------------------------------------ */

function ConversationSection({
  conversation,
  providers,
  personas,
  activeProvider,
  onUpdate,
  onRestart,
}: {
  conversation: Conversation;
  providers: Provider[];
  personas: Persona[];
  activeProvider: Provider | null;
  onUpdate(patch: {
    providerId?: string | null;
    model?: string;
    personaId?: string | null;
    params?: Partial<Conversation['params']>;
  }): void;
  onRestart(): void;
}): JSX.Element {
  const models = activeProvider?.models.length
    ? activeProvider.models
    : conversation.model
      ? [conversation.model]
      : [];

  return (
    <>
      <div className="panel-section">
        <h3>本次对话使用</h3>
        <div className="field">
          <label htmlFor="p-provider">Provider</label>
          <select
            id="p-provider"
            value={conversation.providerId ?? ''}
            onChange={(event) => {
              const id = event.target.value || null;
              const provider = providers.find((p) => p.id === id);
              onUpdate({ providerId: id, model: provider?.defaultModel || '' });
            }}
          >
            <option value="">（跟随全局默认）</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
                {provider.hasKey ? '' : '（未配置 Key）'}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="p-model">模型</label>
          {models.length ? (
            <select
              id="p-model"
              value={conversation.model}
              onChange={(event) => onUpdate({ model: event.target.value })}
            >
              {models.map((model) => (
                <option key={model} value={model}>
                  {model}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="p-model"
              type="text"
              value={conversation.model}
              placeholder="手动填写模型名"
              onChange={(event) => onUpdate({ model: event.target.value })}
            />
          )}
        </div>
        <div className="field">
          <label htmlFor="p-persona">人设</label>
          <select
            id="p-persona"
            value={conversation.personaId ?? ''}
            onChange={(event) => onUpdate({ personaId: event.target.value || null })}
          >
            <option value="">（使用全局默认）</option>
            {personas.map((persona) => (
              <option key={persona.id} value={persona.id}>
                {persona.name}
                {persona.isDefault ? '（默认）' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="panel-section">
        <h3>生成参数（会话级覆盖）</h3>
        <div className="field">
          <label htmlFor="p-temp">
            temperature <span>{conversation.params.temperature.toFixed(2)}</span>
          </label>
          <input
            id="p-temp"
            className="slider"
            type="range"
            min={0}
            max={2}
            step={0.05}
            value={conversation.params.temperature}
            onChange={(event) => onUpdate({ params: { temperature: Number(event.target.value) } })}
          />
        </div>
        <div className="field">
          <label htmlFor="p-topp">
            top_p <span>{conversation.params.topP.toFixed(2)}</span>
          </label>
          <input
            id="p-topp"
            className="slider"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={conversation.params.topP}
            onChange={(event) => onUpdate({ params: { topP: Number(event.target.value) } })}
          />
        </div>
        <div className="field">
          <label htmlFor="p-maxtok">max_tokens</label>
          <input
            id="p-maxtok"
            type="number"
            min={1}
            max={1000000}
            value={conversation.params.maxTokens}
            onChange={(event) =>
              onUpdate({ params: { maxTokens: Math.max(1, Number(event.target.value) || 1) } })
            }
          />
        </div>
      </div>

      <div className="panel-section">
        <h3>开场白</h3>
        <button type="button" className="btn block" onClick={onRestart}>
          用开场白重开这个会话
        </button>
        <div className="sub" style={{ marginTop: 8 }}>
          重开会保留角色卡与参数，清空消息历史。
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 角色标签                                                            */
/* ------------------------------------------------------------------ */

function CharacterSection({
  character,
  onEdit,
}: {
  character: Character | null;
  onEdit(): void;
}): JSX.Element {
  if (!character) return <div className="sub">角色卡已被删除</div>;

  return (
    <>
      <div className="panel-section">
        <h3>{character.name}</h3>
        <div className="tag-list">
          {character.tags.map((tag) => (
            <span key={tag} className="chip" style={{ padding: '3px 9px', fontSize: 12 }}>
              {tag}
            </span>
          ))}
        </div>
      </div>
      <div className="panel-section">
        <h3>角色描述</h3>
        <div className="sub" style={{ lineHeight: '22px', whiteSpace: 'pre-wrap' }}>
          {character.description || '（空）'}
        </div>
      </div>
      <div className="panel-section">
        <h3>系统提示</h3>
        <div className="sub" style={{ lineHeight: '22px', whiteSpace: 'pre-wrap' }}>
          {character.systemPrompt || '（未设置，将用描述/性格/场景拼接）'}
        </div>
      </div>
      <div className="panel-section">
        <button type="button" className="btn block" onClick={onEdit}>
          编辑角色卡
        </button>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 数据标签                                                            */
/* ------------------------------------------------------------------ */

function DataSection({
  conversation,
  summaries,
  onExport,
  onCopyConversation,
  onDeleteConversation,
}: {
  conversation: Conversation;
  summaries: Summary[];
  onExport(kind: 'md' | 'json'): void;
  onCopyConversation(): void;
  onDeleteConversation(): void;
}): JSX.Element {
  return (
    <>
      <div className="panel-section">
        <h3>会话信息</h3>
        <div className="kv">
          <span>消息</span>
          <span>{conversation.messageCount} 条</span>
        </div>
        <div className="kv">
          <span>摘要</span>
          <span>{summaries.length} 段</span>
        </div>
        <div className="kv">
          <span>创建</span>
          <span>{new Date(conversation.createdAt).toLocaleDateString('zh-CN')}</span>
        </div>
        <div className="kv">
          <span>更新</span>
          <span>{new Date(conversation.updatedAt).toLocaleString('zh-CN')}</span>
        </div>
      </div>

      <div className="panel-section">
        <h3>导出</h3>
        <button type="button" className="btn block" style={{ marginBottom: 8 }} onClick={() => onExport('md')}>
          导出 Markdown
        </button>
        <button type="button" className="btn block" onClick={() => onExport('json')}>
          导出 JSON
        </button>
        <button type="button" className="btn block" style={{ marginTop: 8 }} onClick={onCopyConversation}>
          复制整段会话
        </button>
      </div>

      <div className="danger-zone">
        <h3 style={{ fontSize: 13, margin: '0 0 8px' }}>危险区</h3>
        <button type="button" className="btn danger block" onClick={onDeleteConversation}>
          删除这个对话
        </button>
      </div>
    </>
  );
}
