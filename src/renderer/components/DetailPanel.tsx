import { useLayoutEffect, useRef, useState } from 'react';
import type { Character, Conversation, Persona, Provider, Summary, TokenPreview } from '@shared/types.js';
import { PANEL_TABS, usePanelStore } from '../stores/panel.js';
import { useAppStore } from '../stores/app.js';
import { emptyCompression, useCompressStore } from '../stores/compress.js';
import { ConfirmDialog } from './Overlays.js';
import { UiIcon } from './UiIcon.js';
import { buildAvatarUrl } from '@shared/avatar-url.js';

export interface DetailPanelProps {
  conversation: Conversation | null; character: Character | null; providers: Provider[]; personas: Persona[];
  summaries: Summary[]; preview: TokenPreview | null; compressCandidateCount: number;
  onCompress(): void; onRestoreSummary(id: string): void;
  onUpdateConversation(patch: { providerId?: string | null; model?: string; personaId?: string | null; params?: Partial<Conversation['params']> }): Promise<boolean>;
  onRestart(): Promise<boolean>; onExport(kind: 'md' | 'json'): void; onCopyConversation(): void;
  onDeleteConversation(): void;
}

function ConversationSettings({ conversation: c, p }: { conversation: Conversation; p: DetailPanelProps }) {
  const [personaId, setPersonaId] = useState(c.personaId ?? '');
  const [params, setParams] = useState(c.params);
  const [maxTokensDraft, setMaxTokensDraft] = useState(String(c.params.maxTokens));
  const maxTokens = Number(maxTokensDraft);
  const validMaxTokens = /^\d+$/.test(maxTokensDraft) && Number.isInteger(maxTokens) && maxTokens >= 1 && maxTokens <= 1_000_000;
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  return <><p className="dialog-intro">调整这次对话的身份与回复方式。</p><label className="next-field">你的人设<select value={personaId} onChange={e => setPersonaId(e.target.value)}><option value="">跟随默认人设</option>{p.personas.map(persona => <option key={persona.id} value={persona.id}>{persona.name}</option>)}</select></label>
    <details className="advanced-section"><summary>高级生成参数</summary><p className="sub">只对当前会话生效。模型可能不支持所有参数。</p>
      <label className="next-field">随机性 · temperature <span>{params.temperature.toFixed(2)}</span><input type="range" min="0" max="2" step="0.05" value={params.temperature} onChange={e => setParams({ ...params, temperature: Number(e.target.value) })}/></label>
      <label className="next-field">采样范围 · top_p <span>{params.topP.toFixed(2)}</span><input type="range" min="0" max="1" step="0.05" value={params.topP} onChange={e => setParams({ ...params, topP: Number(e.target.value) })}/></label>
      <label className="next-field">最大输出 token<input type="text" inputMode="numeric" placeholder="1–1,000,000（整数）" aria-describedby="max-tokens-help" aria-invalid={maxTokensDraft !== '' && !validMaxTokens} value={maxTokensDraft} onChange={e => { setMaxTokensDraft(e.target.value); setSaved(false); }}/></label>
      <p id="max-tokens-help" className="sub">{maxTokensDraft !== '' && !validMaxTokens ? '请输入 1–1,000,000 之间的整数。' : '实际可用上限取决于所选模型。'}</p>
    </details><div className="panel-actions"><button className="btn" onClick={() => { setPersonaId(c.personaId ?? ''); setParams(c.params); setMaxTokensDraft(String(c.params.maxTokens)); setSaved(false); }}>重置</button><button className="btn primary" disabled={saving || !validMaxTokens} onClick={() => { if (!validMaxTokens) return; setSaving(true); setSaved(false); void p.onUpdateConversation({ personaId: personaId || null, params: { ...params, maxTokens } }).then(ok => setSaved(ok)).finally(() => setSaving(false)); }}>{saving ? '保存中…' : '保存设置'}</button></div>{saved && <p className="sub" role="status">设置已保存</p>}</>;
}

export function DetailPanel(p: DetailPanelProps) {
  const { open, tab, setOpen, setTab } = usePanelStore();
  const settings = useAppStore(s => s.settings);
  const setView = useAppStore(s => s.setView);
  const compress = useCompressStore(s => p.conversation ? s.tasks[p.conversation.id] ?? emptyCompression : emptyCompression);
  const [confirm, setConfirm] = useState<'restart' | Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    if (!open && panelRef.current?.contains(document.activeElement)) toggleRef.current?.focus();
  }, [open]);
  const close = () => { setOpen(false); toggleRef.current?.focus(); };
  if (!p.conversation) return null;
  const avatar = buildAvatarUrl(p.character?.avatarPath ?? null);
  return <>
  <button ref={toggleRef} id="detail-panel-toggle" className="icon-btn detail-toggle" aria-label={open ? '收起右侧栏' : '展开右侧栏'} aria-expanded={open} aria-controls="conversation-details" title={`${open ? '收起' : '展开'}右侧栏 Ctrl+I`} onClick={() => setOpen(!open)}><UiIcon name="panel"/></button>
  {confirm && <ConfirmDialog title={confirm === 'restart' ? '重新开始这段对话？' : '恢复这段原文？'} paragraphs={confirm === 'restart' ? [`将清除 ${p.conversation.messageCount} 条消息和 ${p.summaries.length} 段摘要，再写入角色开场白。`, '角色和生成设置保留，此操作不可撤销。'] : [`恢复第 ${confirm.coversFrom}–${confirm.coversTo} 条原文，并撤销这段摘要。`, '原文将重新参与后续请求，上下文占用可能增加。']} confirmLabel={confirm === 'restart' ? '清空并重开' : '恢复原文'} danger={confirm === 'restart'} busy={busy} onCancel={() => { if (!busy) setConfirm(null); }} onConfirm={() => {
    if (confirm === 'restart') { setBusy(true); void p.onRestart().then(ok => { if (ok) { setConfirm(null); close(); } }).finally(() => setBusy(false)); }
    else { p.onRestoreSummary(confirm.id); setConfirm(null); }
  }}/>}
  <aside ref={panelRef} id="conversation-details" className={`detail-sidebar${open ? '' : ' is-closed'}`} aria-label="对话详情" aria-hidden={!open} inert={!open} onKeyDown={e => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close(); } }}>
    <div className="detail-sidebar-content">
    <header className="detail-header"><h2>对话详情</h2></header>
    <div className="detail-tabs" role="tablist" aria-label="详情分类">{([
      ['character', '角色', 'person'], ['conversation', '对话', 'settings'], ['context', '记忆', 'memory'], ['data', '导出', 'export'],
    ] as const).map(([key, label, icon]) => <button key={key} id={`detail-tab-${key}`} role="tab" aria-selected={tab === key} aria-controls={`detail-${key}`} tabIndex={tab === key ? 0 : -1} onClick={() => setTab(key)} onKeyDown={e => {
      const keys = PANEL_TABS.map(item => item.key);
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      e.preventDefault(); const index = keys.indexOf(key); const next = keys[e.key === 'Home' ? 0 : e.key === 'End' ? 3 : (index + (e.key === 'ArrowRight' ? 1 : 3)) % 4]!;
      setTab(next); document.getElementById(`detail-tab-${next}`)?.focus();
    }}><UiIcon name={icon}/><span>{label}</span></button>)}</div>
    <div className="detail-scroll">
    <section id="detail-conversation" role="tabpanel" aria-labelledby="detail-tab-conversation" hidden={tab !== 'conversation'}><h3>对话设置</h3><ConversationSettings key={p.conversation.id} conversation={p.conversation} p={p}/></section>
    <section id="detail-character" role="tabpanel" aria-labelledby="detail-tab-character" hidden={tab !== 'character'}>
      <div className="detail-character-identity">{avatar ? <img src={avatar} alt=""/> : <div className="detail-avatar"><UiIcon name="person"/></div>}<h3>{p.character?.name || '角色已被移除'}</h3><span>当前对话角色</span></div>
      <div className="character-tags">{p.character?.tags.map(tag => <span key={tag}>{tag}</span>)}</div>
      <details className="advanced-section" open><summary>角色简介</summary><p className="character-description">{p.character?.description || '这个角色还没有简介。'}</p></details>
      {p.character?.scenario && <details className="advanced-section"><summary>故事背景</summary><p className="character-description">{p.character.scenario}</p></details>}
      {p.character?.systemPrompt && <details className="advanced-section"><summary>系统提示</summary><p className="character-description">{p.character.systemPrompt}</p></details>}
    </section><section id="detail-data" role="tabpanel" aria-labelledby="detail-tab-data" hidden={tab !== 'data'}><h3>保存这段对话</h3>
      <p className="dialog-intro">把这段故事带走，或从头开始。</p>
      <div className="export-options"><button onClick={() => p.onExport('md')}><b>导出 Markdown</b><span>适合阅读、保存与分享文本</span><UiIcon name="arrow"/></button><button onClick={() => p.onExport('json')}><b>导出 JSON</b><span>保留完整的会话数据</span><UiIcon name="arrow"/></button><button onClick={p.onCopyConversation}><b>复制整段对话</b><span>复制消息文本到剪贴板</span><UiIcon name="arrow"/></button></div>
      <div className="danger-actions"><button className="btn" onClick={() => setConfirm('restart')}>用开场白重新开始</button><button className="btn danger" onClick={() => { close(); p.onDeleteConversation(); }}>删除这段对话</button></div>
    </section><section id="detail-context" role="tabpanel" aria-labelledby="detail-tab-context" hidden={tab !== 'context'}><h3>对话记忆</h3>
      {p.preview && <div className="memory-capacity"><div><span>上下文占用{p.preview.anyEstimated ? '（估算）' : ''}</span><b>{p.preview.percent}%</b></div><progress aria-label="上下文占用" max="100" value={Math.min(100, Math.max(0, p.preview.percent))}/></div>}
      <p className="dialog-intro">将较早的消息整理成摘要，让故事继续。原文仍会保留。</p>
      <div className="memory-overview"><span className="memory-indicator"><UiIcon name="memory"/></span><div><b>{compress.status === 'running' ? '正在整理记忆…' : p.preview && p.preview.percent >= 75 ? '可以整理一下较早的记忆' : '对话还有空间'}</b><span>{settings?.autoCompressEnabled ? `自动整理已开启 · 达到 ${Math.round(settings.autoCompressThreshold * 100)}% 时触发` : '自动整理未开启'}</span></div></div>
      <button className="btn primary memory-primary" disabled={compress.status === 'running' || p.compressCandidateCount < 4} onClick={p.onCompress}>{compress.status === 'running' ? '正在整理，请稍候…' : '整理较早的消息'}</button>
      <p className="sub">{p.compressCandidateCount < 4 ? '至少需要 4 条可整理的消息。' : '每次整理最早的一组消息，保留原文以便恢复。'}{compress.status === 'running' ? ' 关闭窗口不会停止整理。' : ''}</p>
      {compress.error && <p className="dialog-error" role="alert">{compress.error.message}</p>}
      {compress.lastResult && <p className="sub">最近已整理第 {compress.lastResult.from}–{compress.lastResult.to} 条消息。</p>}
      <details className="advanced-section"><summary>记忆摘要 · {p.summaries.length} 段</summary>{!p.summaries.length && <p className="sub">还没有整理过记忆。</p>}{p.summaries.map(summary => <details key={summary.id} className="summary-record"><summary>第 {summary.coversFrom}–{summary.coversTo} 条消息</summary><p>{summary.content}</p><button className="btn" disabled={compress.status === 'running'} onClick={() => setConfirm(summary)}>恢复原文</button></details>)}</details>
      <details className="advanced-section"><summary>技术明细</summary><p className="sub">当前窗口按 {p.preview?.limit.toLocaleString() ?? '20,000'} token 预算计算，并非供应商公布的模型上限。</p>{p.preview && <><p>{p.preview.anyEstimated ? '约 ' : ''}{p.preview.total.toLocaleString()} token · {p.preview.percent}%</p>{p.preview.segments.map(segment => <div className="memory-token-row" key={segment.kind}><span>{segment.label}</span><span>{!segment.exact && '约 '}{segment.tokens.toLocaleString()}</span></div>)}</>}</details>
      <button className="text-link" onClick={() => setView('settings')}>管理自动整理设置 →</button>
    </section></div>
    </div>
  </aside></>;
}
