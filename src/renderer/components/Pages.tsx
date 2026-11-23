/**
 * 角色库 / 人设 / 设置 三个视图。
 *
 * 放在一个文件里而不是三处：它们共享同一套卡片列表与表单样式，
 * 拆开会让"同一套 token"变成三份几乎相同的 CSS。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { AppDiagnostics, Character, Persona, Provider } from '@shared/types.js';
import { CHARACTER_LANGUAGE_LABEL } from '@shared/character-translation.js';
import { detectCharacterLanguage } from '@core/character-translation.js';
import { buildAvatarUrl } from '@shared/avatar-url.js';
import { Icons } from './Icons.js';
import { CharacterDetailDialog } from './CharacterDetailDialog.js';
import { CharacterTranslationDialog } from './CharacterTranslationDialog.js';
import { ChubSearchPanel } from './ChubSearchPanel.js';
import { CharacterEditorDialog, type CharacterEditPatch } from './CharacterEditor.js';
import { ScrimDialog } from './Overlays.js';
import { UiIcon } from './UiIcon.js';
import { toast } from '../stores/toast.js';

/* ------------------------------------------------------------------ */
/* 角色库                                                              */
/* ------------------------------------------------------------------ */

export interface CharactersPageProps {
  characters: Character[];
  providers: Provider[];
  defaultProviderId: string | null;
  onTranslationSaved(query: string): Promise<void>;
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
  providers,
  defaultProviderId,
  onTranslationSaved,
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
  const [libraryTab, setLibraryTab] = useState<'local' | 'chub'>('local');
  const [query, setQuery] = useState('');
  const [activeTags, setActiveTags] = useState<string[]>([]);
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterControlRef = useRef<HTMLDivElement | null>(null);
  /*
   * 两个浮层都只记 id，角色对象从 props 实时推导：
   * 收藏/编辑后 App 会重新拉列表，若缓存整个对象，弹窗里就会显示旧状态。
   * 顺带解决了"角色被删掉后弹窗要自己关掉"——推导出来是 null 就自动关闭。
   */
  const [detailId, setDetailId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [translatingId, setTranslatingId] = useState<string | null>(null);
  const detailCharacter = detailId
    ? (characters.find((c) => c.id === detailId) ?? null)
    : null;
  const editingCharacter = editingId
    ? (characters.find((c) => c.id === editingId) ?? null)
    : null;
  const translatingCharacter = characters.find((character) => character.id === translatingId);

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
    // 搜索交给主进程；标签与收藏在当前列表上即时筛选，打开面板无需等待。
    onSearchRef.current(query);
  }, [query]);

  useEffect(() => {
    if (!filterOpen) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!filterControlRef.current?.contains(event.target as Node)) setFilterOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setFilterOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [filterOpen]);

  const visible = useMemo(() => {
    return characters.filter((character) => {
      if (favoriteOnly && !character.favorite) return false;
      if (activeTags.length && !character.tags.some((t) => activeTags.includes(t))) return false;
      return true;
    });
  }, [characters, activeTags, favoriteOnly]);

  const activeFilterCount = activeTags.length + (favoriteOnly ? 1 : 0);

  return (
    <div className="page character-library-scroll">
      <div className="page-inner character-library-page">
        <div className="character-library-heading">
          <div>
            <h1>角色库</h1>
          </div>
        </div>

        <div className="character-library-tabs" role="tablist" aria-label="角色库来源">
          {(['local', 'chub'] as const).map((tab) => (
            <button
              key={tab}
              id={`character-tab-${tab}`}
              type="button"
              role="tab"
              aria-controls={`character-panel-${tab}`}
              aria-selected={libraryTab === tab}
              tabIndex={libraryTab === tab ? 0 : -1}
              onClick={() => {
                setFilterOpen(false);
                setLibraryTab(tab);
              }}
              onKeyDown={(event) => {
                const next = event.key === 'Home' ? 'local' : event.key === 'End' ? 'chub'
                  : event.key === 'ArrowLeft' || event.key === 'ArrowRight'
                    ? tab === 'local' ? 'chub' : 'local'
                    : null;
                if (!next) return;
                event.preventDefault();
                setFilterOpen(false);
                setLibraryTab(next);
                document.getElementById(`character-tab-${next}`)?.focus();
              }}
            >
              {tab === 'local' ? '我的卡片' : 'Chub 搜索'}
            </button>
          ))}
        </div>

        <section id="character-panel-local" role="tabpanel" aria-labelledby="character-tab-local" hidden={libraryTab !== 'local'}>
        <div className="page-toolbar character-library-toolbar">
          <input
            type="search"
            placeholder="搜索名称 / 描述 / 标签…"
            aria-label="搜索角色"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="filter-control" ref={filterControlRef}>
            <button
              type="button"
              className={activeFilterCount ? 'btn filter-trigger active' : 'btn filter-trigger'}
              aria-expanded={filterOpen}
              aria-controls="character-filter-menu"
              onClick={() => setFilterOpen((open) => !open)}
            >
              <UiIcon name="filter" />
              <span>筛选</span>
              {activeFilterCount ? <b className="filter-count">{activeFilterCount}</b> : null}
              <UiIcon name={filterOpen ? 'up' : 'down'} />
            </button>

            {filterOpen ? (
              <div
                id="character-filter-menu"
                className="filter-menu"
                role="group"
                aria-label="角色筛选条件"
              >
                <div className="filter-menu-head">
                  <strong>筛选角色</strong>
                  <button
                    type="button"
                    className="filter-clear"
                    disabled={activeFilterCount === 0}
                    onClick={() => {
                      setActiveTags([]);
                      setFavoriteOnly(false);
                    }}
                  >
                    清除
                  </button>
                </div>

                <label className="filter-option">
                  <input
                    type="checkbox"
                    checked={favoriteOnly}
                    onChange={(event) => setFavoriteOnly(event.target.checked)}
                  />
                  <span className="filter-option-label">收藏</span>
                  <span className="filter-option-count">只显示已收藏</span>
                </label>

                {tags.length ? (
                  <div className="filter-menu-section">
                    <div className="filter-menu-label">标签</div>
                    <div className="filter-options">
                      {tags.map(({ tag, count }) => (
                        <label className="filter-option" key={tag}>
                          <input
                            type="checkbox"
                            checked={activeTags.includes(tag)}
                            onChange={() =>
                              setActiveTags((prev) =>
                                prev.includes(tag)
                                  ? prev.filter((item) => item !== tag)
                                  : [...prev, tag],
                              )
                            }
                          />
                          <span className="filter-option-label">{tag}</span>
                          <span className="filter-option-count">{count}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                ) : (
                  <p className="filter-empty">还没有可用标签</p>
                )}
              </div>
            ) : null}
          </div>
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

        {visible.length === 0 ? (
          <div className="empty-page character-empty">
            <strong>{characters.length ? '没有找到符合条件的角色' : '角色库还是空的'}</strong>
            <span>{characters.length ? '试试调整搜索内容或筛选条件。' : '导入一张角色卡，开始构建你的故事。'}</span>
            {characters.length ? (
              <button type="button" className="btn" onClick={() => { setQuery(''); setActiveTags([]); setFavoriteOnly(false); }}>清除搜索与筛选</button>
            ) : null}
          </div>
        ) : (
          /* 角色库用封面和名称保持浏览轻快；点开后查看资料与全部操作。 */
          <div className="char-grid">
            {visible.map((character) => {
              const avatarUrl = buildAvatarUrl(character.avatarPath);
              const languageLabel = character.languageMode ? CHARACTER_LANGUAGE_LABEL[character.languageMode] : '';
              const displayName = languageLabel ? `${character.name} · ${languageLabel}` : character.name;
              return (
                <button
                  type="button"
                  key={character.id}
                  className="char-card"
                  onClick={() => setDetailId(character.id)}
                  title={displayName}
                  aria-label={`查看角色卡：${displayName}`}
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
                  <span className="char-card-caption">
                    <span className="char-card-name">{character.name}</span>
                    {languageLabel ? <span className="character-language-badge">{languageLabel}</span> : null}
                  </span>
                </button>
              );
            })}
          </div>
        )}
        </section>
        <section id="character-panel-chub" role="tabpanel" aria-labelledby="character-tab-chub" hidden={libraryTab !== 'chub'}>
          <ChubSearchPanel
            active={libraryTab === 'chub'}
            onImported={() => onTranslationSaved(query)}
          />
        </section>
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
          onTranslate={() => {
            const language = detectCharacterLanguage(detailCharacter, []);
            if (language === 'zh') return toast('这张卡已经是中文卡');
            if (language === 'bilingual') return toast('这张卡已经是双语卡');
            if (language === 'empty') return toast('这张卡没有可翻译的正文');
            setDetailId(null);
            setTranslatingId(detailCharacter.id);
          }}
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

      {translatingCharacter ? (
        <CharacterTranslationDialog
          character={translatingCharacter}
          providers={providers}
          defaultProviderId={defaultProviderId}
          onClose={() => { setTranslatingId(null); setDetailId(translatingCharacter.id); }}
          onSaved={(character) => {
            setTranslatingId(null);
            setDetailId(character.id);
            toast('已保存新角色卡');
            void onTranslationSaved(query);
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
          设置你在故事中的名字和背景。每段对话可以选择不同的人设，未选择时使用默认人设。
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
    theme?: 'light' | 'dark' | 'system';
  } | null;
  diagnostics: AppDiagnostics | null;
  storageWarning: string | null;
  onUpdateSettings(patch: Record<string, unknown>): void;
}

// 通用设置由独立设置面板承载；连接管理仍复用 ApiKeysPage。
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
        <h1 className="sr-only">通用设置</h1>

        {/* Linux basic_text 降级警告必须显著（产品设计文档 3.1） */}
        {storageWarning ? (
          <div className="storage-warning" role="alert">
            <b>密钥保护已降级：</b>
            {storageWarning}
          </div>
        ) : null}

        <section className="settings-section">
          <h2>主题</h2>
          <div className="theme-options" role="group" aria-label="主题">
            {([
              { value: 'light', label: '浅色', icon: 'sun' },
              { value: 'dark', label: '深色', icon: 'moon' },
              { value: 'system', label: '跟随系统', icon: 'monitor' },
            ] as const).map(option => <button
              key={option.value}
              className="theme-option"
              aria-pressed={(settings?.theme ?? 'system') === option.value}
              onClick={() => onUpdateSettings({ theme: option.value })}
            ><UiIcon name={option.icon}/><span>{option.label}</span></button>)}
          </div>
        </section>
        <section className="settings-section">
          <h2>默认模型连接</h2>
          <div className="setting-row">
            <div className="label">
              <b>聊天连接</b>
              <small>会话未单独指定时使用</small>
            </div>
            <select
              aria-label="聊天连接"
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
              <b>整理记忆使用的连接</b>
              <small>可与聊天不同（例如用更便宜的模型做摘要）</small>
            </div>
            <select
              aria-label="整理记忆使用的连接"
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
          <h2>对话与记忆</h2>
          <div className="setting-row">
            <div className="label">
              <b>自动整理记忆</b>
              <small>接近上下文预算时，将较早的消息整理成摘要，保留原文</small>
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
              <b>整理触发比例</b>
              <small>默认 80%</small>
            </div>
            <input
              type="number"
              aria-label="整理触发比例（百分比）"
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
              aria-label="请求超时（秒）"
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
