/**
 * 角色库 / 人设 / 设置 三个视图。
 *
 * 放在一个文件里而不是三处：它们共享同一套卡片列表与表单样式，
 * 拆开会让"同一套 token"变成三份几乎相同的 CSS。
 */
import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import type {
  AppDiagnostics,
  Character,
  Persona,
  Provider,
  ProviderTestResult,
} from '@shared/types.js';
import { buildAvatarUrl } from '@shared/avatar-url.js';
import { Icons } from './Icons.js';
import { CharacterDetailDialog } from './CharacterDetailDialog.js';

/* ------------------------------------------------------------------ */
/* 角色库                                                              */
/* ------------------------------------------------------------------ */

export interface CharactersPageProps {
  characters: Character[];
  tags: Array<{ tag: string; count: number }>;
  onImportFile(): void;
  onSearch(query: string): void;
  onToggleFavorite(character: Character): void;
  onDelete(character: Character): void;
  onExport(character: Character): void;
  onNewConversation(character: Character): void;
  onSave(character: Character, patch: Partial<Character>): void;
}

export function CharactersPage({
  characters,
  tags,
  onImportFile,
  onSearch,
  onToggleFavorite,
  onDelete,
  onExport,
  onNewConversation,
  onSave,
}: CharactersPageProps): JSX.Element {
  const [query, setQuery] = useState('');
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [editing, setEditing] = useState<Character | null>(null);
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  /*
   * 详情弹窗只记 id，角色对象从 props 实时推导：
   * 收藏/编辑后 App 会重新拉列表，若缓存整个对象，弹窗里就会显示旧状态。
   * 顺带解决了"角色被删掉后弹窗要自己关掉"——推导出来是 null 就自动关闭。
   */
  const [detailId, setDetailId] = useState<string | null>(null);
  const detailCharacter = detailId
    ? (characters.find((c) => c.id === detailId) ?? null)
    : null;

  useEffect(() => {
    // 搜索与标签筛选都交给主进程（那里能一次读全量并精确比标签）
    onSearch(query);
  }, [query, onSearch]);

  const visible = useMemo(() => {
    return characters.filter((character) => {
      if (favoriteOnly && !character.favorite) return false;
      if (activeTags.length && !character.tags.some((t) => activeTags.includes(t))) return false;
      return true;
    });
  }, [characters, activeTags, favoriteOnly]);

  if (editing) {
    return (
      <CharacterEditor
        character={editing}
        onCancel={() => setEditing(null)}
        onSave={(patch) => {
          onSave(editing, patch);
          setEditing(null);
        }}
      />
    );
  }

  return (
    <div className="page">
      <div className="page-inner">
        <h1>角色库</h1>
        <p className="lede">
          兼容 SillyTavern v2 / v3 角色卡。导入时原卡 JSON 会被完整保留，
          导出时以它为基底，因此第三方字段不会丢。
        </p>

        <div className="page-toolbar">
          <input
            type="search"
            placeholder="搜索名称 / 描述 / 标签…"
            aria-label="搜索角色"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <button type="button" className="btn" onClick={() => setFavoriteOnly((v) => !v)}>
            {favoriteOnly ? '显示全部' : '只看收藏'}
          </button>
          <button type="button" className="btn" onClick={onImportFile}>
            {Icons.upload()}
            导入角色卡
          </button>
        </div>

        {tags.length ? (
          <div className="filter-chips">
            {tags.slice(0, 20).map(({ tag, count }) => {
              const active = activeTags.includes(tag);
              return (
                <button
                  key={tag}
                  type="button"
                  className={active ? 'filter-chip active' : 'filter-chip'}
                  onClick={() =>
                    setActiveTags((prev) =>
                      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
                    )
                  }
                >
                  {tag} {count}
                </button>
              );
            })}
          </div>
        ) : null}

        {visible.length === 0 ? (
          <div className="empty-page">还没有角色卡　点击「导入角色卡」添加一个</div>
        ) : (
          /*
           * 卡片网格（2:3 竖版）：上面是角色卡图片，下面是名字。
           * 不显示描述——两个近名角色靠 `title` 悬停提示区分，信息没丢只是不占视觉。
           * 卡片上的全部动作收进详情弹窗（见 CharacterDetailDialog）。
           */
          <div className="char-grid">
            {visible.map((character) => {
              const avatarUrl = buildAvatarUrl(character.avatarPath);
              return (
                <button
                  type="button"
                  key={character.id}
                  className="char-card"
                  onClick={() => setDetailId(character.id)}
                  title={character.description || character.scenario || character.name}
                  aria-label={`查看角色卡：${character.name}`}
                >
                  <span className="char-card-figure">
                    {avatarUrl ? (
                      <img src={avatarUrl} alt="" />
                    ) : (
                      // 没有图片的角色卡：**纯灰色色块**，不放任何图标——
                      // 放个占位小人等于引入了"默认头像"，与本项目的 P9 冲突
                      <span className="char-card-placeholder" aria-hidden="true" />
                    )}
                    {character.favorite ? (
                      <span className="char-card-fav" title="已收藏" aria-hidden="true">
                        ★
                      </span>
                    ) : null}
                  </span>
                  <span className="char-card-name">{character.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {detailCharacter ? (
        <CharacterDetailDialog
          character={detailCharacter}
          onClose={() => setDetailId(null)}
          onNewConversation={() => {
            setDetailId(null);
            onNewConversation(detailCharacter);
          }}
          onToggleFavorite={() => onToggleFavorite(detailCharacter)}
          onEdit={() => {
            setDetailId(null);
            setEditing(detailCharacter);
          }}
          onExport={() => onExport(detailCharacter)}
          onDelete={() => {
            setDetailId(null);
            onDelete(detailCharacter);
          }}
        />
      ) : null}
    </div>
  );
}

/** 角色卡编辑器（可编辑字段来自产品设计文档 3.2）。 */
function CharacterEditor({
  character,
  onSave,
  onCancel,
}: {
  character: Character;
  onSave(patch: Partial<Character>): void;
  onCancel(): void;
}): JSX.Element {
  const [draft, setDraft] = useState<Character>(character);

  const field = (
    key: keyof Character,
    label: string,
    hint?: string,
    rows?: number,
  ): JSX.Element => (
    <div className="field">
      <label htmlFor={`f-${String(key)}`}>
        {label}
        {hint ? <span className="sub">（{hint}）</span> : null}
      </label>
      {rows ? (
        <textarea
          id={`f-${String(key)}`}
          value={String(draft[key] ?? '')}
          rows={rows}
          onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
        />
      ) : (
        <input
          id={`f-${String(key)}`}
          type="text"
          value={String(draft[key] ?? '')}
          onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
        />
      )}
    </div>
  );

  return (
    <div className="page">
      <div className="page-inner">
        <h1>编辑角色卡</h1>
        <p className="lede">
          改动会写回角色卡；原卡的第三方字段仍然原样保留（导出时以 raw_json 为基底）。
        </p>

        <div className="editor-grid">
          {field('name', '名称')}
          {field('description', '描述', 'system_prompt 为空时用于拼接', 4)}
          {field('personality', '性格', undefined, 3)}
          {field('scenario', '场景', undefined, 3)}
          {field('firstMes', '开场白 first_mes', undefined, 3)}
          {field('systemPrompt', 'system_prompt', '留空则用描述/性格/场景拼接', 4)}
          {field('postHistoryInstructions', 'post_history_instructions', undefined, 3)}
          {field('mesExample', '示例对话 mes_example', '用 {{user}}: / {{char}}: 标记', 5)}
        </div>

        <div className="field" style={{ marginTop: 12 }}>
          <label htmlFor="f-tags">标签（逗号分隔）</label>
          <input
            id="f-tags"
            type="text"
            value={draft.tags.join(', ')}
            onChange={(event) =>
              setDraft({
                ...draft,
                tags: event.target.value
                  .split(/[,，]/)
                  .map((t) => t.trim())
                  .filter(Boolean),
              })
            }
          />
        </div>

        <div className="field">
          <label htmlFor="f-alt">备用开场白（每行一条）</label>
          <textarea
            id="f-alt"
            rows={3}
            value={draft.alternateGreetings.join('\n')}
            onChange={(event) =>
              setDraft({
                ...draft,
                alternateGreetings: event.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
              })
            }
          />
        </div>

        <div className="form-actions" style={{ marginTop: 18 }}>
          <button type="button" className="btn primary" style={{ width: 'auto' }} onClick={() => onSave(draft)}>
            保存
          </button>
          <button type="button" className="btn" onClick={onCancel}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 人设                                                                */
/* ------------------------------------------------------------------ */

export interface PersonasPageProps {
  personas: Persona[];
  onCreate(input: { name: string; description: string }): void;
  onUpdate(id: string, patch: Partial<Persona>): void;
  onDelete(persona: Persona): void;
  onSetDefault(persona: Persona): void;
}

export function PersonasPage({
  personas,
  onCreate,
  onUpdate,
  onDelete,
  onSetDefault,
}: PersonasPageProps): JSX.Element {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  return (
    <div className="page">
      <div className="page-inner">
        <h1>人设</h1>
        <p className="lede">
          Persona 是全局资源，用来替换 <code>{'{{user}}'}</code>。每个会话可绑定一个；
          未绑定时使用全局默认。关系落在会话上，不在这里。
        </p>

        <div className="provider-form">
          <div className="field">
            <label htmlFor="persona-name">名称</label>
            <input
              id="persona-name"
              type="text"
              value={name}
              placeholder="例如：ASMobbin"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="persona-desc">描述（可选）</label>
            <input
              id="persona-desc"
              type="text"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </div>
          <div className="form-actions">
            <button
              type="button"
              className="btn primary"
              style={{ width: 'auto' }}
              disabled={!name.trim()}
              onClick={() => {
                onCreate({ name: name.trim(), description });
                setName('');
                setDescription('');
              }}
            >
              新建人设
            </button>
          </div>
        </div>

        {personas.length === 0 ? (
          <div className="empty-page">还没有人设　新建一个，聊天时的「你」就有名字了</div>
        ) : (
          <div className="card-list">
            {personas.map((persona) => (
              <div className="card-row" key={persona.id}>
                <div className="card-main">
                  <div className="card-name">
                    {persona.name}
                    {persona.isDefault ? <span className="sub">（默认）</span> : null}
                  </div>
                  <div className="card-desc">{persona.description || '（没有描述）'}</div>
                </div>
                <div className="card-actions">
                  {!persona.isDefault ? (
                    <button type="button" className="btn" onClick={() => onSetDefault(persona)}>
                      设为默认
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="icon-btn"
                    title="重命名"
                    aria-label="重命名人设"
                    onClick={() => {
                      const next = window.prompt('新名称', persona.name);
                      if (next?.trim()) onUpdate(persona.id, { name: next.trim() });
                    }}
                  >
                    {Icons.edit()}
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title="删除"
                    aria-label="删除人设"
                    onClick={() => onDelete(persona)}
                  >
                    {Icons.trash()}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

export interface SettingsPageProps {
  providers: Provider[];
  settings: {
    chatProviderId: string | null;
    compressionProviderId: string | null;
    autoCompressEnabled: boolean;
    autoCompressThreshold: number;
    sendWithCtrlEnter: boolean;
    requestTimeoutMs: number;
  } | null;
  diagnostics: AppDiagnostics | null;
  storageWarning: string | null;
  onSaveProvider(input: {
    id?: string;
    name: string;
    type: 'openai' | 'anthropic';
    baseUrl: string;
    apiKey?: string;
    clearKey?: boolean;
    models: string[];
    defaultModel: string;
    compressionModel: string;
    enabled: boolean;
  }): Promise<void>;
  onDeleteProvider(id: string): void;
  onTestProvider(id: string): Promise<ProviderTestResult>;
  onUpdateSettings(patch: Record<string, unknown>): void;
  onExportPlainConfig(): void;
}

const EMPTY_PROVIDER: {
  name: string;
  type: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  models: string;
  defaultModel: string;
  compressionModel: string;
  enabled: boolean;
} = {
  name: '',
  type: 'openai',
  baseUrl: '',
  apiKey: '',
  models: '',
  defaultModel: '',
  compressionModel: '',
  enabled: true,
};

export function SettingsPage({
  providers,
  settings,
  diagnostics,
  storageWarning,
  onSaveProvider,
  onDeleteProvider,
  onTestProvider,
  onUpdateSettings,
  onExportPlainConfig,
}: SettingsPageProps): JSX.Element {
  const [form, setForm] = useState({ ...EMPTY_PROVIDER });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, ProviderTestResult>>({});
  const [testing, setTesting] = useState<string | null>(null);

  const resetForm = (): void => {
    setForm({ ...EMPTY_PROVIDER });
    setEditingId(null);
  };

  return (
    <div className="page">
      <div className="page-inner">
        <h1>设置</h1>
        <p className="lede">
          本地优先（BYOK）：API Key 用系统密钥环加密后存在本机，
          应用不代理、不上传、不收费。
        </p>

        {/* Linux basic_text 降级警告必须显著（产品设计文档 3.1） */}
        {storageWarning ? (
          <div className="storage-warning" role="alert">
            <b>密钥保护已降级：</b>
            {storageWarning}
          </div>
        ) : null}

        <section className="settings-section">
          <h2>Provider 与密钥</h2>
          <p className="hint">
            密钥只以密文落库（字段 <code>api_key_enc</code>），明文只在主进程内存中出现一次；
            界面与日志都不会出现明文。
          </p>

          {providers.map((provider) => {
            const result = testResults[provider.id];
            return (
              <div key={provider.id} className="setting-row" style={{ alignItems: 'flex-start' }}>
                <div className="label">
                  <b>
                    {provider.name}{' '}
                    <span className="sub">
                      {provider.type === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'}
                      {provider.enabled ? '' : ' · 已停用'}
                    </span>
                  </b>
                  <small>{provider.baseUrl}</small>
                  <small>
                    <span className={provider.hasKey ? 'key-status ok' : 'key-status warn'}>
                      {provider.hasKey ? '已配置 Key' : '未配置 Key'}
                    </span>
                    {provider.defaultModel ? ` · 默认模型 ${provider.defaultModel}` : ''}
                  </small>
                  {result ? (
                    <div
                      className={
                        result.outcome === 'ok'
                          ? 'test-result ok'
                          : result.outcome === 'auth-failed'
                            ? 'test-result warn'
                            : 'test-result fail'
                      }
                      style={{ marginTop: 8 }}
                    >
                      {result.outcome === 'ok'
                        ? '可达，鉴权通过'
                        : result.outcome === 'auth-failed'
                          ? '可达，鉴权失败'
                          : '不可达'}
                      {result.httpStatus ? `（HTTP ${result.httpStatus}）` : ''}
                      {' · '}
                      {result.message}
                      {result.models.length ? ` · 发现 ${result.models.length} 个模型` : ''}
                    </div>
                  ) : null}
                </div>
                <div className="form-actions" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
                  <button
                    type="button"
                    className="btn"
                    disabled={!provider.hasKey || testing === provider.id}
                    onClick={async () => {
                      setTesting(provider.id);
                      try {
                        const result = await onTestProvider(provider.id);
                        setTestResults((prev) => ({ ...prev, [provider.id]: result }));
                      } finally {
                        setTesting(null);
                      }
                    }}
                  >
                    {testing === provider.id ? '测试中…' : '测试连接'}
                  </button>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      setEditingId(provider.id);
                      setForm({
                        name: provider.name,
                        type: provider.type,
                        baseUrl: provider.baseUrl,
                        apiKey: '',
                        models: provider.models.join(', '),
                        defaultModel: provider.defaultModel,
                        compressionModel: provider.compressionModel,
                        enabled: provider.enabled,
                      });
                    }}
                  >
                    编辑
                  </button>
                  <button type="button" className="btn danger" onClick={() => onDeleteProvider(provider.id)}>
                    删除
                  </button>
                </div>
              </div>
            );
          })}

          <div className="provider-form" style={{ marginTop: 16 }}>
            <div className="field">
              <label htmlFor="p-name">名称</label>
              <input
                id="p-name"
                type="text"
                value={form.name}
                placeholder="例如：本地 DeepSeek"
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="p-type">类型</label>
              <select
                id="p-type"
                value={form.type}
                onChange={(event) =>
                  setForm({ ...form, type: event.target.value as 'openai' | 'anthropic' })
                }
              >
                <option value="openai">OpenAI 兼容</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="p-url">base_url</label>
              <input
                id="p-url"
                type="text"
                value={form.baseUrl}
                placeholder="https://api.example.com/v1"
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="p-key">
                API Key{editingId ? '（留空表示不修改已保存的 Key）' : ''}
              </label>
              <input
                id="p-key"
                type="password"
                value={form.apiKey}
                autoComplete="off"
                onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="p-models">模型列表（逗号分隔）</label>
              <input
                id="p-models"
                type="text"
                value={form.models}
                placeholder="deepseek-chat, deepseek-reasoner"
                onChange={(event) => setForm({ ...form, models: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="p-default">默认模型 / 压缩模型</label>
              <input
                id="p-default"
                type="text"
                value={form.defaultModel}
                placeholder="deepseek-chat"
                onChange={(event) =>
                  setForm({ ...form, defaultModel: event.target.value, compressionModel: event.target.value })
                }
              />
            </div>
            <div className="form-actions">
              <button
                type="button"
                className="btn primary"
                style={{ width: 'auto' }}
                disabled={!form.name.trim() || !form.baseUrl.trim()}
                onClick={async () => {
                  await onSaveProvider({
                    ...(editingId ? { id: editingId } : {}),
                    name: form.name.trim(),
                    type: form.type,
                    baseUrl: form.baseUrl.trim(),
                    ...(form.apiKey ? { apiKey: form.apiKey } : {}),
                    models: form.models
                      .split(/[,，]/)
                      .map((m) => m.trim())
                      .filter(Boolean),
                    defaultModel: form.defaultModel.trim(),
                    compressionModel: form.compressionModel.trim() || form.defaultModel.trim(),
                    enabled: form.enabled,
                  });
                  resetForm();
                }}
              >
                {editingId ? '保存修改' : '添加 Provider'}
              </button>
              {editingId ? (
                <button type="button" className="btn" onClick={resetForm}>
                  取消
                </button>
              ) : null}
            </div>
          </div>

          <button type="button" className="btn danger" style={{ marginTop: 12 }} onClick={onExportPlainConfig}>
            导出明文配置包（用于换机）
          </button>
          <div className="hint" style={{ marginTop: 6 }}>
            明文导出会包含 API Key，需要二次确认。注意：safeStorage 的密文绑定本机用户凭据，
            因此直接拷贝 cottage.db 到另一台机器无法解密——换机请用这个文件。
          </div>
        </section>

        <section className="settings-section">
          <h2>全局默认</h2>
          <div className="setting-row">
            <div className="label">
              <b>聊天默认 Provider</b>
              <small>会话未单独指定时使用</small>
            </div>
            <select
              value={settings?.chatProviderId ?? ''}
              onChange={(event) => onUpdateSettings({ chatProviderId: event.target.value || null })}
            >
              <option value="">（未设置）</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="setting-row">
            <div className="label">
              <b>压缩默认 Provider</b>
              <small>可与聊天不同（例如用更便宜的模型做摘要）</small>
            </div>
            <select
              value={settings?.compressionProviderId ?? ''}
              onChange={(event) => onUpdateSettings({ compressionProviderId: event.target.value || null })}
            >
              <option value="">（跟随聊天默认）</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
        </section>

        <section className="settings-section">
          <h2>生成与行为</h2>
          <div className="setting-row">
            <div className="label">
              <b>自动压缩</b>
              <small>上下文占用超过阈值时自动压缩最老的历史</small>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings?.autoCompressEnabled ?? true}
                onChange={(event) => onUpdateSettings({ autoCompressEnabled: event.target.checked })}
              />
              启用
            </label>
          </div>
          <div className="setting-row">
            <div className="label">
              <b>自动压缩阈值</b>
              <small>默认 80%</small>
            </div>
            <input
              type="number"
              min={10}
              max={100}
              value={Math.round((settings?.autoCompressThreshold ?? 0.8) * 100)}
              onChange={(event) =>
                onUpdateSettings({
                  autoCompressThreshold: Math.min(1, Math.max(0.1, Number(event.target.value) / 100)),
                })
              }
            />
          </div>
          <div className="setting-row">
            <div className="label">
              <b>用 Ctrl+Enter 发送</b>
              <small>关闭时 Enter 直接发送、Shift+Enter 换行</small>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={settings?.sendWithCtrlEnter ?? false}
                onChange={(event) => onUpdateSettings({ sendWithCtrlEnter: event.target.checked })}
              />
              启用
            </label>
          </div>
          <div className="setting-row">
            <div className="label">
              <b>请求超时</b>
              <small>超时后按中断处理，已收到内容会保留</small>
            </div>
            <input
              type="number"
              min={5}
              max={600}
              value={Math.round((settings?.requestTimeoutMs ?? 60_000) / 1000)}
              onChange={(event) =>
                onUpdateSettings({
                  requestTimeoutMs: Math.min(600_000, Math.max(5_000, Number(event.target.value) * 1000)),
                })
              }
            />
          </div>
        </section>

        <section className="settings-section">
          <h2>诊断</h2>
          <p className="hint">数据库位置、迁移版本与密钥存储后端。排查问题时先看这里。</p>
          {diagnostics ? (
            <div className="diag-list">
              <div>
                <span>数据库</span>
                <span>{diagnostics.dbPath}</span>
              </div>
              <div>
                <span>schema 版本</span>
                <span>
                  {diagnostics.userVersion} / {diagnostics.latestVersion}
                  {diagnostics.userVersion === diagnostics.latestVersion ? '（已最新）' : '（待迁移）'}
                </span>
              </div>
              <div>
                <span>密钥存储后端</span>
                <span>{diagnostics.storageBackend}</span>
              </div>
              <div>
                <span>平台</span>
                <span>{diagnostics.platform}</span>
              </div>
              <div>
                <span>Electron</span>
                <span>{diagnostics.electronVersion}</span>
              </div>
              <div>
                <span>应用版本</span>
                <span>{diagnostics.appVersion}</span>
              </div>
            </div>
          ) : (
            <div className="sub">正在读取…</div>
          )}
        </section>
      </div>
    </div>
  );
}
