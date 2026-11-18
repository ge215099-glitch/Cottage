import { useState } from 'react';
import type { Character, Persona, Provider } from '@shared/types.js';
import { buildAvatarUrl } from '@shared/avatar-url.js';
import type { CharacterEditPatch } from './CharacterEditor.js';
import { ScrimDialog } from './Overlays.js';

export interface NewConversationChoice { characterId: string; personaId: string | null; providerId: string }
export interface NewConversationWizardProps {
  characters: Character[]; personas: Persona[]; providers: Provider[];
  initialCharacterId?: string | null; defaultProviderId?: string | null;
  onSaveCharacter(character: Character, patch: CharacterEditPatch): Promise<string | null>;
  busy?: boolean; error?: string | null;
  onConfirm(choice: NewConversationChoice): void; onCancel(): void;
  onGoCharacters(): void; onGoPersonas(): void; onGoApiKeys(): void;
}
export function NewConversationWizard(p: NewConversationWizardProps) {
  const providers = p.providers.filter(provider => provider.enabled && provider.hasKey);
  const [characterId, setCharacterId] = useState(p.initialCharacterId ?? '');
  const [personaId, setPersonaId] = useState(p.personas.find(persona => persona.isDefault)?.id ?? '');
  const [providerId, setProviderId] = useState(providers.find(provider => provider.id === p.defaultProviderId)?.id ?? providers[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const characters = p.characters.filter(c => c.name.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <ScrimDialog title="开启一段新对话" className="form-dialog new-conversation-dialog" onClose={() => { if (!p.busy) p.onCancel(); }} footer={<><button className="btn" onClick={p.onCancel} disabled={p.busy}>取消</button><button className="btn primary" disabled={!characterId || !providerId || p.busy} onClick={() => p.onConfirm({ characterId, personaId: personaId || null, providerId })}>{p.busy ? '正在开启…' : '开始对话'}</button></>}>
    <p className="dialog-intro">选一个角色，继续你们的故事。</p>
    {p.characters.length ? <><input className="character-search" placeholder="寻找角色…" aria-label="寻找角色" value={query} onChange={e => setQuery(e.target.value)}/><div className="character-picker">{characters.map(c => <button className={`character-option ${c.id === characterId ? 'chosen' : ''}`} key={c.id} onClick={() => setCharacterId(c.id)} aria-pressed={c.id === characterId}>{c.avatarPath ? <img src={buildAvatarUrl(c.avatarPath)!} alt=""/> : <span className="character-placeholder"/>}<span><b>{c.name}</b><small>{c.description || '等待与你相遇'}</small></span><span className="choice-dot"/></button>)}{!characters.length && <p className="sub">没有找到这个角色。</p>}</div></> : <div className="onboarding-card"><p>你的角色库还是空的</p><button className="btn" onClick={p.onGoCharacters}>去导入角色卡</button></div>}
    <div className="new-chat-defaults"><label>聊天连接<select aria-label="聊天连接" value={providerId} onChange={e => setProviderId(e.target.value)}>{!providers.length && <option value="">尚未配置</option>}{providers.map(provider => <option key={provider.id} value={provider.id}>{provider.name} · {provider.defaultModel || provider.models[0] || '未选择模型'}</option>)}</select></label><label>你的人设<select aria-label="你的人设" value={personaId} onChange={e => setPersonaId(e.target.value)}><option value="">默认身份</option>{p.personas.map(persona => <option key={persona.id} value={persona.id}>{persona.name}</option>)}</select></label></div>
    {!providers.length && <div className="inline-notice">添加一个模型连接，就可以开始聊天。<button onClick={p.onGoApiKeys}>配置连接 →</button></div>}
    {p.error && <p className="dialog-error" role="alert">{p.error}</p>}
  </ScrimDialog>;
}
