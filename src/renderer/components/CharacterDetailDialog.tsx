/**
 * 角色卡详情弹窗。
 *
 * 为什么是"点卡片 → 详情弹窗"而不是"卡片上挂一排图标"：
 * 角色卡的动作有五个（开新对话 / 编辑 / 收藏 / 导出 / 删除），其中删除还是危险动作。
 * 摊在卡片上会让网格变成按钮墙（违反 P2「低频动作隐藏」），收进 `⋯` 又要用户
 * 先猜哪张卡有菜单。放进详情弹窗则一次解决三件事：看清这张卡是什么、
 * 哪里有全部动作、误触删除的概率更低。
 *
 * 只读展示，编辑交给既有的 `CharacterEditor`（点「编辑」切过去）。
 */
import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import type { Character } from '@shared/types.js';
import { buildAvatarUrl } from '@shared/avatar-url.js';
import { Icons } from './Icons.js';

export interface CharacterDetailDialogProps {
  character: Character;
  onClose(): void;
  onNewConversation(): void;
  onToggleFavorite(): void;
  onEdit(): void;
  onExport(): void;
  onDelete(): void;
}

export function CharacterDetailDialog({
  character,
  onClose,
  onNewConversation,
  onToggleFavorite,
  onEdit,
  onExport,
  onDelete,
}: CharacterDetailDialogProps): JSX.Element {
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const avatarUrl = buildAvatarUrl(character.avatarPath);
  const facts: Array<[string, string]> = [
    ['描述', character.description],
    ['性格', character.personality],
    ['场景', character.scenario],
    ['开场白', character.firstMes],
  ];

  return (
    <div className="overlay-root">
      <div
        className="scrim"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <div
          ref={dialogRef}
          className="dialog char-detail"
          role="dialog"
          aria-modal="true"
          aria-label={`角色详情：${character.name}`}
          tabIndex={-1}
        >
          <div className="char-detail-head">
            <div className="char-detail-figure">
              {avatarUrl ? (
                <img src={avatarUrl} alt="" />
              ) : (
                // 与卡片一致：纯灰色色块，不放占位小人（那等于默认头像）
                <div className="char-detail-placeholder" aria-hidden="true" />
              )}
            </div>

            <div className="char-detail-info">
              <h3>
                {character.name}
                {character.favorite ? (
                  <span className="fav" title="已收藏">
                    ★
                  </span>
                ) : null}
              </h3>
              {character.tags.length ? (
                <div className="char-detail-tags">
                  {character.tags.map((tag) => (
                    <span className="tag-chip" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="char-detail-actions">
                <button
                  type="button"
                  className="btn primary"
                  style={{ width: 'auto' }}
                  onClick={onNewConversation}
                >
                  新对话
                </button>
                <button type="button" className="btn" onClick={onEdit}>
                  编辑
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title={character.favorite ? '取消收藏' : '收藏'}
                  aria-label={character.favorite ? '取消收藏' : '收藏'}
                  onClick={onToggleFavorite}
                >
                  {Icons.star()}
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="导出"
                  aria-label="导出角色卡"
                  onClick={onExport}
                >
                  {Icons.export()}
                </button>
                <button
                  type="button"
                  className="icon-btn danger"
                  title="删除"
                  aria-label="删除角色卡"
                  onClick={onDelete}
                >
                  {Icons.trash()}
                </button>
              </div>
            </div>
          </div>

          <div className="char-detail-body">
            {facts
              .filter(([, value]) => value.trim())
              .map(([label, value]) => (
                <div className="char-detail-field" key={label}>
                  <div className="char-detail-label">{label}</div>
                  <div className="char-detail-value">{value}</div>
                </div>
              ))}
          </div>

          <div className="actions">
            <button type="button" className="btn" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
