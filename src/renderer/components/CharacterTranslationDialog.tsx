import { useEffect, useMemo, useRef, useState } from 'react';
import { CHARACTER_LANGUAGE_LABEL, TRANSLATABLE_FIELDS, type TranslationFields } from '@shared/character-translation.js';
import type { Character, CharacterLanguageMode, Provider } from '@shared/types.js';
import { detectCharacterLanguage } from '@core/character-translation.js';
import { toast } from '../stores/toast.js';
import { ScrimDialog } from './Overlays.js';

const api = () => window.cottage;

interface CharacterTranslationDialogProps {
  character: Character;
  providers: Provider[];
  defaultProviderId: string | null;
  onClose(): void;
  onSaved(character: Character): void;
}

function availableModels(provider: Provider) {
  return [...new Set([provider.defaultModel, ...provider.models].filter(Boolean))];
}

export function CharacterTranslationDialog({ character, providers, defaultProviderId, onClose, onSaved }: CharacterTranslationDialogProps) {
  const connections = providers.filter((provider) => provider.enabled && provider.hasKey && availableModels(provider).length);
  const initialConnection = connections.find((provider) => provider.id === defaultProviderId) ?? connections[0];
  const [providerId, setProviderId] = useState(initialConnection?.id ?? '');
  const [model, setModel] = useState(initialConnection ? availableModels(initialConnection)[0] ?? '' : '');
  const [mode, setMode] = useState<CharacterLanguageMode>('zh');
  const [terms, setTerms] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [phase, setPhase] = useState<'setup' | 'generating' | 'preview' | 'saving'>('setup');
  const [fields, setFields] = useState<TranslationFields | null>(null);
  const [error, setError] = useState('');
  const requestRef = useRef<string | null>(null);
  const titleRef = useRef<HTMLSelectElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const connection = connections.find((provider) => provider.id === providerId);
  const models = connection ? availableModels(connection) : [];
  const protectedTerms = useMemo(() => [...new Set(terms.split(/\r?\n/).map((term) => term.trim()).filter(Boolean))], [terms]);
  const source = useMemo(() => detectCharacterLanguage(character, protectedTerms), [character, protectedTerms]);

  useEffect(() => () => {
    const requestId = requestRef.current;
    if (requestId) void api().characters.cancelTranslation(requestId).catch(() => undefined);
    requestRef.current = null;
  }, []);

  useEffect(() => {
    if (phase === 'preview') previewRef.current?.focus();
  }, [phase]);

  const stop = () => {
    const requestId = requestRef.current;
    requestRef.current = null;
    if (requestId) void api().characters.cancelTranslation(requestId).catch(() => undefined);
    setFields(null);
    setPhase('setup');
  };

  async function generate() {
    if (requestRef.current) return;
    if (source === 'zh') {
      toast('这张卡已经是中文卡');
      onClose();
      return;
    }
    if (source === 'empty') {
      setError('这张卡没有可翻译的正文');
      return;
    }
    if (protectedTerms.length > 100 || protectedTerms.some((term) => term.length > 200)) {
      setError('最多可锁定 100 个名称或术语，每项最多 200 个字符。');
      return;
    }
    if (!connection || !models.includes(model) || (source === 'uncertain' && !confirmed)) return;
    const requestId = crypto.randomUUID();
    requestRef.current = requestId;
    setError('');
    setPhase('generating');
    try {
      const result = await api().characters.translate({
        requestId, characterId: character.id, mode, providerId, model, protectedTerms, confirmUncertain: confirmed,
      });
      if (requestRef.current !== requestId) return;
      if (result.ok && result.data.status === 'preview') {
        setFields(result.data.fields);
        setPhase('preview');
        return;
      }
      stop();
      if (!result.ok) setError(result.error.message);
      else if (result.data.status === 'already-zh' || result.data.status === 'already-bilingual') {
        toast(result.data.status === 'already-zh' ? '这张卡已经是中文卡' : '这张卡已经是双语卡');
        onClose();
      } else if (result.data.status === 'empty') setError('这张卡没有可翻译的正文');
      else if (result.data.status === 'confirm-language') setError('原卡内容已变化，请重新打开角色卡确认语言。');
    } catch {
      if (requestRef.current !== requestId) return;
      stop();
      setError('转换未完成，请重试。');
    }
  }

  async function save() {
    const requestId = requestRef.current;
    if (!requestId || phase !== 'preview') return;
    setPhase('saving');
    setError('');
    try {
      const result = await api().characters.saveTranslation(requestId);
      if (requestRef.current !== requestId) return;
      if (result.ok) {
        requestRef.current = null;
        onSaved(result.data);
        return;
      }
      setError(result.error.message);
    } catch {
      setError('保存未完成，请重试。');
    }
    setPhase('preview');
  }

  const previewing = phase === 'preview' || phase === 'saving';
  const generating = phase === 'generating';
  const previewFields: Array<[string, string]> = fields ? [
    ...Object.entries(TRANSLATABLE_FIELDS).map(([key, label]): [string, string] => [label, fields[key as keyof typeof TRANSLATABLE_FIELDS]]),
    ...fields.alternateGreetings.map((greeting, index): [string, string] => [`备用开场白 ${index + 1}`, greeting]),
  ] : [];

  return (
    <ScrimDialog title="转换角色卡语言" className="form-dialog character-translation-dialog" initialFocusRef={titleRef}
      onClose={() => { if (phase !== 'saving') onClose(); }}
      footer={previewing ? <>
        <button type="button" className="btn" disabled={phase === 'saving'} onClick={() => { setError(''); stop(); }}>返回修改</button>
        <button type="button" className="btn primary" disabled={phase === 'saving'} onClick={() => void save()}>{phase === 'saving' ? '正在保存…' : '保存为新角色卡'}</button>
      </> : <>
        <button type="button" className="btn" onClick={generating ? stop : onClose}>{generating ? '停止生成' : '取消'}</button>
        <button type="button" className="btn primary" disabled={generating || (source !== 'zh' && (!models.includes(model) || (source === 'uncertain' && !confirmed)))} onClick={() => void generate()}>
          {generating ? '正在生成…' : '生成预览'}
        </button>
      </>}
    >
      {previewing ? (
        <div className="character-translation-body" ref={previewRef} tabIndex={-1}>
          <p className="character-translation-name">{character.name} <span className="character-language-badge">{CHARACTER_LANGUAGE_LABEL[mode]}</span></p>
          {previewFields.filter(([, text]) => text.trim()).map(([label, text]) => (
            <section className="char-detail-field" key={label}>
              <h4 className="char-detail-label">{label}</h4>
              <div className="char-detail-value">{text}</div>
            </section>
          ))}
        </div>
      ) : (
        <div className="character-translation-body character-translation-fields" aria-busy={generating}>
          <label>语言版本
            <select ref={titleRef} value={mode} disabled={generating} onChange={(event) => setMode(event.target.value === 'bilingual' ? 'bilingual' : 'zh')}>
              <option value="zh">中文版</option>
              <option value="bilingual">中英双语版</option>
            </select>
          </label>
          <div className="character-translation-models">
            <label>模型连接
              <select value={providerId} disabled={generating || !connections.length} onChange={(event) => {
                const next = connections.find((provider) => provider.id === event.target.value);
                setProviderId(next?.id ?? '');
                setModel(next ? availableModels(next)[0] ?? '' : '');
              }}>
                {!connections.length ? <option value="">尚未配置</option> : null}
                {connections.map((provider) => <option value={provider.id} key={provider.id}>{provider.name}</option>)}
              </select>
            </label>
            <label>翻译模型
              <select value={model} disabled={generating || !models.length} onChange={(event) => setModel(event.target.value)}>
                {!models.length ? <option value="">暂无模型</option> : null}
                {models.map((name) => <option value={name} key={name}>{name}</option>)}
              </select>
            </label>
          </div>
          <label>保持原样的专有名词
            <span className="character-translation-hint">已锁定角色名。其他人名、地名或术语每行填一项。</span>
            <textarea rows={3} maxLength={20_100} value={terms} disabled={generating} onChange={(event) => { setTerms(event.target.value); setConfirmed(false); }} />
          </label>
          {source === 'uncertain' ? <label className="character-translation-confirm">
            <input type="checkbox" checked={confirmed} disabled={generating} onChange={(event) => setConfirmed(event.target.checked)} />
            原卡语言不明确，继续转换
          </label> : null}
          {connections.length ? <p className="character-translation-hint">生成预览时，待翻译内容会发送给所选模型。</p> : <p className="character-translation-hint">请先在设置中配置模型连接。</p>}
        </div>
      )}
      {error ? <p className="dialog-error" role="alert">{error}</p> : null}
      {generating ? <p className="character-translation-hint" role="status">正在翻译并核对角色卡内容…</p> : null}
    </ScrimDialog>
  );
}
