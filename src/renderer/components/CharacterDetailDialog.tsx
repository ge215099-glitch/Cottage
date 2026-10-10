/**
 * 角色卡详情弹窗。
 *
 * 为什么是"点卡片 → 详情弹窗"而不是"卡片上挂一排图标"：
 * 角色卡的动作有五个（开新对话 / 编辑 / 收藏 / 导出 / 删除），其中删除还是危险动作。
 * 摊在卡片上会让网格变成按钮墙（违反 P2「低频动作隐藏」），收进 `⋯` 又要用户
 * 先猜哪张卡有菜单。放进详情弹窗则一次解决三件事：看清这张卡是什么、
 * 哪里有全部动作、误触删除的概率更低。
 *
 * 导出有 json / png 两种格式，所以按钮不直接导出，而是**开菜单**让用户选格式
 * （锚点就是按钮自己，用既有的单一菜单实例，不另造一套浮层）。
 *
 * 只读展示，编辑交给既有的 `CharacterEditor`（点「编辑」切过去）。
 */
import { useEffect, useRef } from 'react';
import type { JSX } from 'react';
import type { Character } from '@shared/types.js';
import { buildAvatarUrl } from '@shared/avatar-url.js';
import { isMenuOpen, useMenuStore } from '../stores/menu.js';
import { Icons } from './Icons.js';

export interface CharacterDetailDialogProps {
  character: Character;
  onClose(): void;
  onNewConversation(): void;
  onToggleFavorite(): void;
  onEdit(): void;
  /** 导出：把自己当锚点交给调用方开格式菜单 */
  onExport(rect: DOMRect, trigger: HTMLElement): void;
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
        /*
         * 菜单开着的时候 Esc 只关菜单，不穿透到底下的弹窗。
         *
         * 如果两层都响应，"按一下 Esc"会把弹窗和菜单一起关掉——用户以为只是
         * 收起了菜单，结果整张卡也关了。菜单是后开的层，它才是栈顶。
         *
         * 两个判据都要看：应用外壳的全局 Esc 处理会先跑一遍并把菜单关掉
         * （那时 `isMenuOpen` 已经是 false，只剩 `defaultPrevented` 能说明
         * "这一下已经被消费了"）；而监听器的注册顺序不该被依赖。
         */
        if (event.defaultPrevented || isMenuOpen(useMenuStore.getState())) return;
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
                {/*
                 * 图标必须跟着状态走：空心 = 未收藏、实心 = 已收藏。
                 *
                 * 这里此前**两种状态都画空心星**，于是"收藏了没有"在按钮上完全看不出来，
                 * 用户点完只能靠标题栏里那个小星去猜有没有生效——等于没有反馈。
                 * `aria-pressed` 一并给出，读屏用户和视觉用户拿到的是同一个事实。
                 */}
                <button
                  type="button"
                  className={character.favorite ? 'icon-btn fav-on' : 'icon-btn'}
                  title={character.favorite ? '取消收藏' : '收藏'}
                  aria-label={character.favorite ? '取消收藏' : '收藏'}
                  aria-pressed={character.favorite}
                  onClick={onToggleFavorite}
                >
                  {character.favorite ? Icons.starFilled() : Icons.star()}
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  title="导出"
                  aria-label="导出角色卡"
                  aria-haspopup="menu"
                  onClick={(event) =>
                    onExport(
                      event.currentTarget.getBoundingClientRect(),
                      event.currentTarget,
                    )
                  }
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
