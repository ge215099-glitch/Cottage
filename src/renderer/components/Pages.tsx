/**
 * 角色库 / 人设 / 设置 三个视图。
 *
 * 放在一个文件里而不是三处：它们共享同一套卡片列表与表单样式，
 * 拆开会让"同一套 token"变成三份几乎相同的 CSS。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { AppDiagnostics, Character, Persona, Provider } from '@shared/types.js';
import { buildAvatarUrl } from '@shared/avatar-url.js';
import { Icons } from './Icons.js';
import { CharacterDetailDialog } from './CharacterDetailDialog.js';
import { CharacterEditorDialog, type CharacterEditPatch } from './CharacterEditor.js';
import { ScrimDialog } from './Overlays.js';

/* ------------------------------------------------------------------ */
/* 角色库                                                              */
/* ------------------------------------------------------------------ */

export interface CharactersPageProps {
  characters: Character[];
  tags: Array<{ tag: string; count: number }>;
  /**
   * 导入是否正在进行。
   *
   * 有了它，按钮在导入期间是禁用的：「导入角色卡」要弹**原生文件对话框**、选完文件
   * 还要解析入库，这几秒里按钮看起来毫无反应，用户必然连点——连点会叠出多个原生
   * 对话框（模态霸占输入，像卡死），也会真的导入出好几张重复的卡。
   */
  importing: boolean;
  onImportFile(): void;
  onSearch(query: string): void;
  onToggleFavorite(character: Character): void;
  onDelete(character: Character): void;
  /** 导出：`rect` / `trigger` 用来把格式菜单锚在按钮上 */
  onExport(character: Character, rect: DOMRect, trigger: HTMLElement): void;
  onNewConversation(character: Character): void;
  /** 编辑角色卡；返回错误文案表示失败（弹窗留在原地、草稿不丢） */
  onSave(character: Character, patch: CharacterEditPatch): Promise<string | null>;
}

export function CharactersPage({
  characters,
  tags,
  importing,
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
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  /*
   * 两个浮层都只记 id，角色对象从 props 实时推导：
   * 收藏/编辑后 App 会重新拉列表，若缓存整个对象，弹窗里就会显示旧状态。
   * 顺带解决了"角色被删掉后弹窗要自己关掉"——推导出来是 null 就自动关闭。
   */
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const detailCharacter = detailId
    ? (characters.find((c) => c.id === detailId) ?? null)
    : null;
  const editingCharacter = editingId
    ? (characters.find((c) => c.id === editingId) ?? null)
    : null;

  /**
   * `onSearch` 放在 ref 里，effect **只依赖 `query`**。
   *
   * 依赖数组里绝不能直接放 `onSearch`：App 传下来的是内联箭头函数，每次渲染都是
   * 新身份（React 用 Object.is 比依赖，见 react.dev 的 "Removing Effect Dependencies"），
   * 于是"渲染 → 跑 effect → onSearch → 主进程返回新数组 → setCharacters → 渲染"
   * 变成**停不下来的循环**：角色库会持续发 IPC、持续重渲染，表现就是页面彻底没反应
   * （点按钮、切页都在等主线程）。实测真卡一张就有 110 KB～600 KB，这个循环还要
   * 把它们来回搬，所以卡得越来越死。
   *
   * 用 ref 而不是把 `onSearch` 记进依赖，是因为这里要的语义是"query 变了才重新搜"，
   * 而不是"回调换了个身份就重新搜"——后者正是上面那个 bug。
   */
  const onSearchRef = useRef(onSearch);
  useEffect(() => {
    onSearchRef.current = onSearch;
  }, [onSearch]);

  useEffect(() => {
    // 搜索与标签筛选都交给主进程（那里能一次读全量并精确比标签）
    onSearchRef.current(query);
  }, [query]);

  const visible = useMemo(() => {
    return characters.filter((character) => {
      if (favoriteOnly && !character.favorite) return false;
      if (activeTags.length && !character.tags.some((t) => activeTags.includes(t))) return false;
      return true;
    });
  }, [characters, activeTags, favoriteOnly]);

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
          <button
            type="button"
            className="btn"
            disabled={importing}
            aria-busy={importing}
            onClick={onImportFile}
          >
            {Icons.upload()}
            {importing ? '正在导入…' : '导入角色卡'}
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
                      /*
                       * 用实心 SVG 星，不用文本 `★`：文本星的字形来自系统字体，
                       * 与全应用的内联 SVG 图标不是一套（线宽、比例都对不上），
                       * 而且没有底色时压在花哨的卡面图上会被吃掉。形状与详情弹窗
                       * 的收藏按钮共用 `Icons.starFilled`，两处永远一致。
                       */
                      <span className="char-card-fav" title="已收藏" aria-hidden="true">
                        {Icons.starFilled({ size: 12 })}
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
          /*
           * 「编辑」不再是"整页切到编辑器"，而是换成编辑弹窗。
           *
           * 详情弹窗先关掉、编辑弹窗关闭后再回到详情弹窗（而不是两个弹窗叠着）：
           * 两层弹窗同时挂着的话，按 Esc 会**两层一起关**——两个监听器都在
           * document 上，先注册的详情弹窗先跑，它看不到"这层不是栈顶"。
           * 与其为此造一套浮层栈，不如让它们永远只有一层。
           * 保存后回到详情弹窗还有个好处：看到的就是刚改完的那张卡。
           */
          onEdit={() => {
            setDetailId(null);
            setEditingId(detailCharacter.id);
          }}
          onExport={(rect, trigger) => onExport(detailCharacter, rect, trigger)}
          onDelete={() => {
            setDetailId(null);
            onDelete(detailCharacter);
          }}
        />
      ) : null}

      {editingCharacter ? (
        <CharacterEditorDialog
          character={editingCharacter}
          onClose={() => {
            setEditingId(null);
            // 回到进来时那张卡的详情（角色已被删掉时推导为 null，自动不显示）
            setDetailId(editingCharacter.id);
          }}
          onSave={onSave}
        />
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 人设                                                                */
/* ------------------------------------------------------------------ */

export interface PersonaSaveInput {
  /** 有 id = 编辑，没有 = 新建 */
  id?: string;
  name: string;
  description: string;
  isDefault: boolean;
}

export interface PersonasPageProps {
  personas: Persona[];
  /** 新建与编辑共用一个入口，返回错误文案表示失败（失败时弹窗留在原地） */
  onSave(input: PersonaSaveInput): Promise<string | null>;
  onDelete(persona: Persona): void;
}

/**
 * 弹窗里的表单状态（只在打开时从 persona 初始化一次）。
 */
interface PersonaFormState {
  name: string;
  description: string;
  isDefault: boolean;
}

/** 打开着的到底是"新建"还是"编辑某一条"——由 editing 与当前列表推导，不另存一份。 */
type DialogTarget = 'new' | Persona | null;

/**
 * 人设页：**列表 + 弹窗**，与「API Key」页同一套形态。
 *
 * 三条刻意的设计（第一条是修一个真实报上来的 bug）：
 *
 * 1. **编辑走弹窗，不用 `window.prompt`**。Electron 的 renderer 里 `prompt()` 是
 *    未实现的空函数（返回 null 且不弹任何窗口），所以"点编辑改名字"整条路径
 *    此前是**静默失效**的——点下去什么都不会发生，也看不到任何报错。
 *    而且改名之外还有描述与「设为默认」，一行 `prompt` 本来就装不下。
 * 2. **页面上不常驻创建表单**。新建也是一次弹窗：常驻表单会让"我有哪几个人设"
 *    淹没在一排输入框里，和 API Key 页的理由完全一样。
 * 3. **「设为默认」进弹窗，不做成每行一个按钮**。它是这一份人设的属性，
 *    不是每行都要摆出来的动作；行上只留「编辑 / 删除」两个按需出现的图标。
 */
export function PersonasPage({ personas, onSave, onDelete }: PersonasPageProps): JSX.Element {
  /** null = 弹窗关闭；`'new'` = 新建；其余是正在编辑的 persona id */
  const [editing, setEditing] = useState<'new' | string | null>(null);
  const [form, setForm] = useState<PersonaFormState>({ name: '', description: '', isDefault: false });
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  /**
   * 弹窗目标：`'new'`、某一条 persona，或 null（关闭）。
   *
   * 关键是从 props **实时推导**，而不是把 persona 对象缓存在 state 里：
   * 保存成功、外部删除、列表刷新之后，这里会自动反映最新事实——
   * 尤其是"弹窗里的那条人设已经不存在了"时它会自己关掉，
   * 不会退化成一个标题写着「新建人设」、底下却在编辑鬼魂的框。
   */
  const target: DialogTarget =
    editing === null
      ? null
      : editing === 'new'
        ? 'new'
        : (personas.find((p) => p.id === editing) ?? null);
  const editingPersona = target && target !== 'new' ? target : null;

  const close = (): void => {
    if (saving) return;
    setEditing(null);
    setFormError(null);
  };

  const openNew = (): void => {
    // 库里还没有人设时先勾上「设为默认」：第一个必然成为默认（DAO 也是这么做的），
    // 把这件事摆在明面上，用户不用事后回来再勾一次。
    setForm({ name: '', description: '', isDefault: personas.length === 0 });
    setFormError(null);
    setEditing('new');
  };

  const openEdit = (persona: Persona): void => {
    setForm({
      name: persona.name,
      description: persona.description,
      isDefault: persona.isDefault,
    });
    setFormError(null);
    setEditing(persona.id);
  };

  const submit = async (): Promise<void> => {
    const name = form.name.trim();
    if (!name) return;
    setSaving(true);
    setFormError(null);
    const error = await onSave({
      ...(editingPersona ? { id: editingPersona.id } : {}),
      name,
      description: form.description,
      isDefault: form.isDefault,
    });
    setSaving(false);
    // 失败就留在弹窗里报错：把用户刚填的一屏内容丢掉是最差的做法
    if (error) setFormError(error);
    else setEditing(null);
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head-row">
          <h1>人设</h1>
          <div className="page-head-actions">
            <button type="button" className="btn primary" style={{ width: 'auto' }} onClick={openNew}>
              新建人设
            </button>
          </div>
        </div>
        <p className="lede">
          Persona 是全局资源，用来替换 <code>{'{{user}}'}</code>。每个会话可绑定一个；
          未绑定时使用全局默认。关系落在会话上，不在这里。
        </p>

        {personas.length === 0 ? (
          <div className="empty-page">还没有人设　点击「新建人设」创建第一个</div>
        ) : (
          <div className="card-list">
            {personas.map((persona) => (
              <div className="card-row" key={persona.id}>
                <div className="card-main">
                  <div className="card-name">
                    {persona.name}
                    {persona.isDefault ? <span className="tag">默认</span> : null}
                  </div>
                  <div className="card-desc">{persona.description || '（没有描述）'}</div>
                </div>
                <div className="card-actions">
                  <button
                    type="button"
                    className="icon-btn"
                    title="编辑"
                    aria-label={`编辑 ${persona.name}`}
                    onClick={() => openEdit(persona)}
                  >
                    {Icons.edit()}
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    title="删除"
                    aria-label={`删除 ${persona.name}`}
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

      {target ? (
        <ScrimDialog
          title={editingPersona ? `编辑人设：${editingPersona.name}` : '新建人设'}
          className="form-dialog"
          initialFocusRef={firstFieldRef}
          onClose={close}
          footer={
            <>
              {editingPersona ? (
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => {
                    close();
                    onDelete(editingPersona);
                  }}
                >
                  删除
                </button>
              ) : null}
              <div className="spacer" />
              <button type="button" className="btn" disabled={saving} onClick={close}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                style={{ width: 'auto' }}
                disabled={saving || !form.name.trim()}
                onClick={() => void submit()}
              >
                {editingPersona ? '保存修改' : '创建'}
              </button>
            </>
          }
        >
          <div className="provider-form">
            <div className="field">
              <label htmlFor="persona-name">名称</label>
              <input
                ref={firstFieldRef}
                id="persona-name"
                type="text"
                value={form.name}
                placeholder="例如：ASMobbin"
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="persona-desc">描述（可选）</label>
              <input
                id="persona-desc"
                type="text"
                value={form.description}
                placeholder="例如：旅人，话不多"
                onChange={(event) => setForm({ ...form, description: event.target.value })}
              />
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={form.isDefault}
                onChange={(event) => setForm({ ...form, isDefault: event.target.checked })}
              />
              设为默认人设
            </label>
          </div>
          {formError ? (
            <div className="dialog-error" role="alert">
              {formError}
            </div>
          ) : null}
        </ScrimDialog>
      ) : null}
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
  onUpdateSettings(patch: Record<string, unknown>): void;
}

/*
 * 设置页只留"全局默认 / 生成与行为 / 诊断"三段。
 *
 * Provider 与密钥的增删改**不在这里**——它有自己的导航模块（`ApiKeysPage`），
 * 列表 + 弹窗编辑都在那边。设置页保留"聊天默认 Provider / 压缩默认 Provider"
 * 两个下拉，是因为它们描述的是"默认值"，不是某把 Key 自身的配置。
 */
export function SettingsPage({
  providers,
  settings,
  diagnostics,
  storageWarning,
  onUpdateSettings,
}: SettingsPageProps): JSX.Element {
  return (
    <div className="page">
      <div className="page-inner">
        <h1>设置</h1>

        {/* Linux basic_text 降级警告必须显著（产品设计文档 3.1） */}
        {storageWarning ? (
          <div className="storage-warning" role="alert">
            <b>密钥保护已降级：</b>
            {storageWarning}
          </div>
        ) : null}

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
