import { useEffect, useRef, useState } from 'react';
import { chubSearchUrl, type ChubCard, type ChubPage, type ChubQuery } from '@shared/chub.js';
import { UiIcon } from './UiIcon.js';
import { ScrimDialog } from './Overlays.js';
import { MarkdownBody } from './MarkdownBody.js';
import { toast } from '../stores/toast.js';

interface ChubSearchPanelProps {
  active: boolean;
  onImported(): Promise<void>;
}

function ChubCover({ path }: { path: string }) {
  const [image, setImage] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void window.cottage.chub.cover(path).then((result) => {
      if (current && result.ok) setImage(result.data);
    }).catch(() => undefined);
    return () => { current = false; };
  }, [path]);
  return (
    <span className="char-card-figure">
      {image ? <img src={image} alt="" loading="lazy" /> : <span className="char-card-placeholder" aria-hidden="true" />}
    </span>
  );
}

export function ChubSearchPanel({ active, onImported }: ChubSearchPanelProps) {
  const [keyword, setKeyword] = useState('');
  const [query, setQuery] = useState<ChubQuery>({ keyword: '', page: 1 });
  const [resultPage, setResultPage] = useState<ChubPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<ChubCard | null>(null);
  const [saving, setSaving] = useState(false);
  const [importError, setImportError] = useState('');
  const request = useRef(0);
  const started = useRef(false);

  async function search(next: ChubQuery): Promise<void> {
    const version = ++request.current;
    setQuery(next);
    setLoading(true);
    setError('');
    setResultPage(null);
    try {
      const result = await window.cottage.chub.search(next);
      if (request.current !== version) return;
      if (result.ok) setResultPage(result.data);
      else setError(result.error.message);
    } catch {
      if (request.current === version) setError('无法连接 Chub，请稍后重试。');
    } finally {
      if (request.current === version) setLoading(false);
    }
  }

  useEffect(() => {
    if (active && !started.current) {
      started.current = true;
      void search({ keyword: '', page: 1 });
    }
  }, [active]);

  async function save(card: ChubCard): Promise<void> {
    setSaving(true);
    setImportError('');
    try {
      const result = await window.cottage.chub.importCard(card.path);
      if (!result.ok) {
        setImportError(result.error.message);
        return;
      }
      const imported = { ...card, imported: true };
      setSelected(imported);
      setResultPage((previous) => previous && ({
        ...previous,
        cards: previous.cards.map((candidate) => candidate.path === card.path ? imported : candidate),
      }));
      toast(`已导入「${card.name}」`);
      await onImported();
    } catch {
      setImportError('无法完成导入，请稍后重试。');
    } finally {
      setSaving(false);
    }
  }

  const searchUrl = chubSearchUrl({ keyword: keyword.trim(), page: 1 }).href;
  return (
    <>
      <form className="page-toolbar character-library-toolbar" role="search" aria-label="Chub 搜索" onSubmit={(event) => {
        event.preventDefault();
        void search({ keyword: keyword.trim(), page: 1 });
      }}>
        <input
          type="search"
          aria-label="搜索 Chub 角色卡"
          placeholder="搜索 Chub 角色卡…"
          maxLength={200}
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
        />
        <button type="submit" className="btn"><UiIcon name="search" />搜索</button>
        <a className="btn" href={searchUrl} target="_blank" rel="noreferrer">在 Chub 打开<UiIcon name="arrow" /></a>
      </form>
      {loading && <div className="empty-page" role="status">正在搜索 Chub…</div>}
      {error && <div className="empty-page character-empty" role="alert">
        <span>{error}</span>
        <button type="button" className="btn" onClick={() => void search(query)}>重试</button>
      </div>}
      {resultPage && <>
        {resultPage.cards.length ? (
          <div className="char-grid">
            {resultPage.cards.map((card) => (
              <button
                type="button"
                key={card.path}
                className="char-card chub-card"
                aria-label={`预览 Chub 角色卡：${card.name}`}
                onClick={() => { setImportError(''); setSelected(card); }}
              >
                <ChubCover path={card.path} />
                <span className="char-card-caption">
                  <span className="char-card-name">{card.name}</span>
                  <span className="chub-card-author">@{card.path.split('/')[0]}</span>
                  {card.imported && <span className="character-language-badge">已导入</span>}
                </span>
              </button>
            ))}
          </div>
        ) : <div className="empty-page" role="status">本页没有符合条件的角色卡。</div>}
        {(query.page > 1 || resultPage.hasNext) && <nav className="chub-pagination" aria-label="Chub 搜索分页">
          <button type="button" className="btn" disabled={query.page === 1} onClick={() => void search({ ...query, page: query.page - 1 })}>上一页</button>
          <span>第 {query.page} 页</span>
          <button type="button" className="btn" disabled={!resultPage.hasNext} onClick={() => void search({ ...query, page: query.page + 1 })}>下一页</button>
        </nav>}
      </>}
      {selected && <ScrimDialog
        title={selected.name}
        className="chub-preview"
        onClose={() => { if (!saving) setSelected(null); }}
        footer={<>
          <a className="btn" href={`https://chub.ai/characters/${selected.path}`} target="_blank" rel="noreferrer">在 Chub 查看</a>
          <div className="spacer" />
          <button type="button" className="btn" disabled={saving} onClick={() => setSelected(null)}>关闭</button>
          <button type="button" className="btn primary" disabled={saving || selected.imported} onClick={() => void save(selected)}>
            {saving ? '正在导入…' : selected.imported ? '已导入' : '导入到我的卡片'}
          </button>
        </>}
      >
        <p className="chub-card-author">@{selected.path.split('/')[0]}</p>
        <div className="chub-description"><MarkdownBody content={selected.description || '暂无简介'} /></div>
        {importError && <div className="dialog-error" role="alert">{importError}</div>}
      </ScrimDialog>}
    </>
  );
}
