import { useState } from 'react';
import type { Character, Conversation, Persona, Provider, Summary, TokenPreview } from '@shared/types.js';
import { usePanelStore } from '../stores/panel.js';
import { useAppStore } from '../stores/app.js';
import { emptyCompression, useCompressStore } from '../stores/compress.js';
import { ConfirmDialog, ScrimDialog } from './Overlays.js';
import { UiIcon } from './UiIcon.js';

export interface DetailPanelProps {
  conversation: Conversation | null; character: Character | null; providers: Provider[]; personas: Persona[];
  summaries: Summary[]; preview: TokenPreview | null; compressCandidateCount: number;
  onCompress(): void; onRestoreSummary(id: string): void;
  onUpdateConversation(patch: { providerId?: string | null; model?: string; personaId?: string | null; params?: Partial<Conversation['params']> }): Promise<boolean>;
  onRestart(): Promise<boolean>; onExport(kind: 'md' | 'json'): void; onCopyConversation(): void;
  onDeleteConversation(): void; onEditCharacter(): void;
}

function ConversationSettings({ conversation: c, p, close }: { conversation: Conversation; p: DetailPanelProps; close(): void }) {
  const [personaId, setPersonaId] = useState(c.personaId ?? '');
  const [params, setParams] = useState(c.params);
  const [saving, setSaving] = useState(false);
  return <><p className="dialog-intro">调整这次对话的身份与回复方式。</p><label className="next-field">你的人设<select value={personaId} onChange={e => setPersonaId(e.target.value)}><option value="">跟随默认人设</option>{p.personas.map(persona => <option key={persona.id} value={persona.id}>{persona.name}</option>)}</select></label>
    <details className="advanced-section"><summary>高级生成参数</summary><p className="sub">只对当前会话生效。模型可能不支持所有参数。</p>
      <label className="next-field">随机性 · temperature <span>{params.temperature.toFixed(2)}</span><input type="range" min="0" max="2" step="0.05" value={params.temperature} onChange={e => setParams({ ...params, temperature: Number(e.target.value) })}/></label>
      <label className="next-field">采样范围 · top_p <span>{params.topP.toFixed(2)}</span><input type="range" min="0" max="1" step="0.05" value={params.topP} onChange={e => setParams({ ...params, topP: Number(e.target.value) })}/></label>
      <label className="next-field">最大输出 token<input type="number" min="1" max="1000000" value={params.maxTokens} onChange={e => setParams({ ...params, maxTokens: Number(e.target.value) })}/></label>
    </details><div className="panel-actions"><button className="btn" onClick={close}>取消</button><button className="btn primary" disabled={saving || params.maxTokens < 1 || params.maxTokens > 1000000} onClick={() => { setSaving(true); void p.onUpdateConversation({ personaId: personaId || null, params }).then(ok => { if (ok) close(); }).finally(() => setSaving(false)); }}>{saving ? '保存中…' : '保存设置'}</button></div></>;
}

export function DetailPanel(p: DetailPanelProps) {
  const { open, tab, setOpen } = usePanelStore();
  const settings = useAppStore(s => s.settings);
  const setView = useAppStore(s => s.setView);
  const compress = useCompressStore(s => p.conversation ? s.tasks[p.conversation.id] ?? emptyCompression : emptyCompression);
  const [confirm, setConfirm] = useState<'restart' | Summary | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => setOpen(false);
  if (!open || !p.conversation) return null;
  const title = { context: '对话记忆', conversation: '对话设置', character: '角色资料', data: '导出与更多操作' }[tab];
  if (confirm) return <ConfirmDialog title={confirm === 'restart' ? '重新开始这段对话？' : '恢复这段原文？'} paragraphs={confirm === 'restart' ? [`将清除 ${p.conversation.messageCount} 条消息和 ${p.summaries.length} 段摘要，再写入角色开场白。`, '角色和生成设置保留，此操作不可撤销。'] : [`恢复第 ${confirm.coversFrom}–${confirm.coversTo} 条原文，并撤销这段摘要。`, '原文将重新参与后续请求，上下文占用可能增加。']} confirmLabel={confirm === 'restart' ? '清空并重开' : '恢复原文'} danger={confirm === 'restart'} busy={busy} onCancel={() => { if (!busy) setConfirm(null); }} onConfirm={() => {
    if (confirm === 'restart') { setBusy(true); void p.onRestart().then(ok => { if (ok) { setConfirm(null); close(); } }).finally(() => setBusy(false)); }
    else { p.onRestoreSummary(confirm.id); setConfirm(null); }
  }}/>;
  return <ScrimDialog title={title} className={`form-dialog next-detail-dialog ${tab === 'context' ? 'memory-dialog' : ''}`} onClose={close}>
    <button className="dialog-close icon-btn" aria-label="关闭面板" onClick={close}><UiIcon name="close"/></button>
    {tab === 'conversation' ? <ConversationSettings key={p.conversation.id} conversation={p.conversation} p={p} close={close}/> : tab === 'character' ? <>
      <p className="dialog-intro">{p.character?.name || '角色已被移除'}</p>
      <div className="character-tags">{p.character?.tags.map(tag => <span key={tag}>{tag}</span>)}</div>
      <p className="character-description">{p.character?.description || '这个角色还没有简介。'}</p>
      {p.character?.scenario && <details className="advanced-section"><summary>故事背景</summary><p className="character-description">{p.character.scenario}</p></details>}
      {p.character?.systemPrompt && <details className="advanced-section"><summary>系统提示</summary><p className="character-description">{p.character.systemPrompt}</p></details>}
      <button className="btn" onClick={() => { close(); p.onEditCharacter(); }}>前往角色库编辑</button>
    </> : tab === 'data' ? <>
      <p className="dialog-intro">把这段故事带走，或从头开始。</p>
      <div className="export-options"><button onClick={() => p.onExport('md')}><b>导出 Markdown</b><span>适合阅读、保存与分享文本</span><UiIcon name="arrow"/></button><button onClick={() => p.onExport('json')}><b>导出 JSON</b><span>保留完整的会话数据</span><UiIcon name="arrow"/></button><button onClick={p.onCopyConversation}><b>复制整段对话</b><span>复制消息文本到剪贴板</span><UiIcon name="arrow"/></button></div>
      <div className="danger-actions"><button className="btn" onClick={() => setConfirm('restart')}>用开场白重新开始</button><button className="btn danger" onClick={() => { close(); p.onDeleteConversation(); }}>删除这段对话</button></div>
    </> : <>
      <p className="dialog-intro">将较早的消息整理成摘要，让故事继续。原文仍会保留。</p>
      <div className="memory-overview"><span className="memory-indicator"><UiIcon name="memory"/></span><div><b>{compress.status === 'running' ? '正在整理记忆…' : p.preview && p.preview.percent >= 75 ? '可以整理一下较早的记忆' : '对话还有空间'}</b><span>{settings?.autoCompressEnabled ? `自动整理已开启 · 达到 ${Math.round(settings.autoCompressThreshold * 100)}% 时触发` : '自动整理未开启'}</span></div></div>
      <button className="btn primary memory-primary" disabled={compress.status === 'running' || p.compressCandidateCount < 4} onClick={p.onCompress}>{compress.status === 'running' ? '正在整理，请稍候…' : '整理较早的消息'}</button>
      <p className="sub">{p.compressCandidateCount < 4 ? '至少需要 4 条可整理的消息。' : '每次整理最早的一组消息，保留原文以便恢复。'}{compress.status === 'running' ? ' 关闭窗口不会停止整理。' : ''}</p>
      {compress.error && <p className="dialog-error" role="alert">{compress.error.message}</p>}
      {compress.lastResult && <p className="sub">最近已整理第 {compress.lastResult.from}–{compress.lastResult.to} 条消息。</p>}
      <details className="advanced-section"><summary>记忆摘要 · {p.summaries.length} 段</summary>{!p.summaries.length && <p className="sub">还没有整理过记忆。</p>}{p.summaries.map(summary => <details key={summary.id} className="summary-record"><summary>第 {summary.coversFrom}–{summary.coversTo} 条消息</summary><p>{summary.content}</p><button className="btn" disabled={compress.status === 'running'} onClick={() => setConfirm(summary)}>恢复原文</button></details>)}</details>
      <details className="advanced-section"><summary>技术明细</summary><p className="sub">当前窗口按 {p.preview?.limit.toLocaleString() ?? '20,000'} token 预算计算，并非供应商公布的模型上限。</p>{p.preview && <><p>{p.preview.anyEstimated ? '约 ' : ''}{p.preview.total.toLocaleString()} token · {p.preview.percent}%</p>{p.preview.segments.map(segment => <div className="memory-token-row" key={segment.kind}><span>{segment.label}</span><span>{!segment.exact && '约 '}{segment.tokens.toLocaleString()}</span></div>)}</>}</details>
      <button className="text-link" onClick={() => { close(); setView('settings'); }}>管理自动整理设置 →</button>
    </>}
  </ScrimDialog>;
}
