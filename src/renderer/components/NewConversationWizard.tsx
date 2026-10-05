/**
 * 「新建对话」向导（3 步）。
 *
 * 为什么是向导而不是一键创建：新建会话要定三件事——**用谁聊（角色）、你是谁（人设）、
 * 用哪个 Key（Provider）**。旧实现是"点一下就建"，于是用哪个角色、哪个 Key 全靠
 * 应用替用户猜（`activeCharacter ?? characters[0]` + 全局默认 Provider），
 * 用户既看不见也改不了，建错了还得进设置里返工。
 *
 * 交互约定：
 *   - 每一步都必须显式确认，不存在"跳过整步"的暗门；
 *   - 预选值是**可见的**：人设预选全局默认，Provider 预选设置的默认聊天 Provider，
 *     用户只需确认，不需要为了通过而多点几下；
 *   - 每一步缺数据时给出明确的下一步动作（去角色库 / 去人设 / 去设置），
 *     而不是让按钮静默变灰。
 *
 * 从角色卡上的「新对话」进入时用 `initialCharacterId`：角色已经定了，
 * 就从第 2 步（选人设）开始，少一次无意义的点击。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { Character, Persona, Provider } from '@shared/types.js';
import { Icons } from './Icons.js';

export interface NewConversationChoice {
  characterId: string;
  personaId: string | null;
  providerId: string;
}

export interface NewConversationWizardProps {
  characters: Character[];
  personas: Persona[];
  providers: Provider[];
  /** 预设角色：设定后直接从「选人设」那一步开始 */
  initialCharacterId?: string | null;
  /** 全局默认聊天 Provider（settings.chatProviderId），用作预选 */
  defaultProviderId?: string | null;
  busy?: boolean;
  error?: string | null;
  onConfirm(choice: NewConversationChoice): void;
  onCancel(): void;
  /** 缺数据时跳去对应页面（向导会被关闭） */
  onGoCharacters(): void;
  onGoPersonas(): void;
  onGoSettings(): void;
}

const STEP_TITLES = ['选择角色', '选择人设', '选择 Key'] as const;

/** 只列出启用的 Provider：停用的不该出现在"用哪个 Key"里。 */
function usableProviders(providers: Provider[]): Provider[] {
  return providers.filter((p) => p.enabled);
}

export function NewConversationWizard({
  characters,
  personas,
  providers,
  initialCharacterId,
  defaultProviderId,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
  onGoCharacters,
  onGoPersonas,
  onGoSettings,
}: NewConversationWizardProps): JSX.Element {
  const presetCharacter = characters.find((c) => c.id === initialCharacterId) ?? null;
  const options = useMemo(() => usableProviders(providers), [providers]);

  const [step, setStep] = useState(presetCharacter ? 1 : 0);
  const [characterId, setCharacterId] = useState<string | null>(presetCharacter?.id ?? null);
  // 人设与 Provider 都预选"默认值"，这样正常路径只需要一路确认
  const [personaId, setPersonaId] = useState<string | null>(
    (personas.find((p) => p.isDefault) ?? personas[0])?.id ?? null,
  );
  const [providerId, setProviderId] = useState<string | null>(
    options.find((p) => p.id === defaultProviderId)?.id ?? options[0]?.id ?? null,
  );

  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  // Esc 关闭（与 ConfirmDialog 一致）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onCancel]);

  const totalSteps = STEP_TITLES.length;
  const isLast = step === totalSteps - 1;
  const canAdvance =
    step === 0 ? Boolean(characterId) : step === 1 ? true : Boolean(providerId);

  const next = (): void => {
    if (isLast) {
      if (!characterId || !providerId) return;
      onConfirm({ characterId, personaId, providerId });
      return;
    }
    setStep((s) => s + 1);
  };

  return (
    <div className="overlay-root">
      <div
        className="scrim"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onCancel();
        }}
      >
        <div
          ref={dialogRef}
          className="dialog wizard"
          role="dialog"
          aria-modal="true"
          aria-label="新建对话"
          tabIndex={-1}
        >
          <div className="wizard-head">
            <h3>新建对话</h3>
            <span className="wizard-progress">
              第 {step + 1} 步 / 共 {totalSteps} 步 · {STEP_TITLES[step]}
            </span>
          </div>

          <div className="wizard-body">
            {step === 0 ? (
              characters.length ? (
                <ChoiceList
                  label="用哪个角色聊"
                  items={characters.map((c) => ({
                    id: c.id,
                    title: c.name,
                    meta: c.description || '（没有描述）',
                  }))}
                  selectedId={characterId}
                  onSelect={setCharacterId}
                />
              ) : (
                <EmptyStep
                  hint="角色库还是空的。先导入一张角色卡，才能开始对话。"
                  actionLabel="去角色库导入"
                  onAction={onGoCharacters}
                />
              )
            ) : null}

            {step === 1 ? (
              personas.length ? (
                <ChoiceList
                  label="你是谁（人设）"
                  items={personas.map((p) => ({
                    id: p.id,
                    title: p.name + (p.isDefault ? '（默认）' : ''),
                    meta: p.description || '（没有描述）',
                  }))}
                  selectedId={personaId}
                  onSelect={setPersonaId}
                />
              ) : (
                <EmptyStep
                  hint="还没有人设。人设是可选的，也可以先去创建再回来。"
                  actionLabel="去创建人设"
                  onAction={onGoPersonas}
                />
              )
            ) : null}

            {step === 2 ? (
              options.length ? (
                <ChoiceList
                  label="用哪个 Key"
                  items={options.map((p) => ({
                    id: p.id,
                    title: p.name,
                    meta: `${p.defaultModel || '未设默认模型'} · ${
                      p.hasKey ? '密钥已保存' : '未保存密钥'
                    }`,
                  }))}
                  selectedId={providerId}
                  onSelect={setProviderId}
                />
              ) : (
                <EmptyStep
                  hint="还没有可用的 Provider。先在设置里配置一个 Key 才能开始对话。"
                  actionLabel="去设置"
                  onAction={onGoSettings}
                />
              )
            ) : null}
          </div>

          {error ? <div className="dialog-error">{error}</div> : null}

          <div className="actions">
            <button type="button" className="btn" onClick={onCancel} disabled={busy}>
              取消
            </button>
            <div className="spacer" />
            {step > 0 ? (
              <button
                type="button"
                className="btn"
                onClick={() => setStep((s) => s - 1)}
                disabled={busy}
              >
                上一步
              </button>
            ) : null}
            <button
              type="button"
              className="btn primary"
              style={{ width: 'auto' }}
              onClick={next}
              disabled={busy || !canAdvance || (isLast && !options.length)}
            >
              {isLast ? '开始对话' : '下一步'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ChoiceItem {
  id: string;
  title: string;
  meta: string;
}

/** 单步的单选列表。用 radiogroup 语义，键盘可用。 */
function ChoiceList({
  label,
  items,
  selectedId,
  onSelect,
}: {
  label: string;
  items: ChoiceItem[];
  selectedId: string | null;
  onSelect(id: string): void;
}): JSX.Element {
  return (
    <div className="choice-group" role="radiogroup" aria-label={label}>
      <p className="choice-label">{label}</p>
      <div className="choice-list">
        {items.map((item) => {
          const active = item.id === selectedId;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={active}
              className={active ? 'choice active' : 'choice'}
              onClick={() => onSelect(item.id)}
            >
              <span className="choice-check" aria-hidden="true">
                {active ? Icons.check() : null}
              </span>
              <span className="choice-text">
                <span className="choice-title">{item.title}</span>
                <span className="choice-meta">{item.meta}</span>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function EmptyStep({
  hint,
  actionLabel,
  onAction,
}: {
  hint: string;
  actionLabel: string;
  onAction(): void;
}): JSX.Element {
  return (
    <div className="wizard-empty">
      <p>{hint}</p>
      <button type="button" className="btn" onClick={onAction}>
        {actionLabel}
      </button>
    </div>
  );
}
