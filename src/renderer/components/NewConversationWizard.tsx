/**
 * 「新建对话」向导（4 步）。
 *
 * 为什么是向导而不是一键创建：新建会话要定四件事——**用谁聊（角色）、这张卡这次
 * 要不要改（自定义）、你是谁（人设）、用哪个 Key（Provider）**。旧实现是"点一下
 * 就建"，于是用哪个角色、哪个 Key 全靠应用替用户猜（`activeCharacter ?? characters[0]`
 * + 全局默认 Provider），用户既看不见也改不了，建错了还得进配置里返工。
 *
 * 交互约定：
 *   - 每一步都必须显式确认，不存在"跳过整步"的暗门；
 *   - 预选值是**可见的**：人设预选全局默认，Provider 预选设置的默认聊天 Provider，
 *     用户只需确认，不需要为了通过而多点几下；
 *   - 每一步缺数据时给出明确的下一步动作（去角色库 / 去人设 / 去 API Key），
 *     而不是让按钮静默变灰。
 *
 * 第 2 步「自定义角色信息」是后来插进来的（原来是 选角色 → 选人设 → 选 Key）：
 * 选完角色往往才发现开场白要改一句、场景要补一笔，而那时人已经在向导里了。
 * 这一步用的是**同一个编辑面板**（`CharacterForm`）——与角色库的「编辑」是同一份
 * 表单、同一套字段口径，不另造一套"向导专用精简版"，否则两处必然漂移。
 *
 * 两个必须说清的口径（否则这一步就是个陷阱）：
 *   1. **写回的是角色卡本身，所有会话共享**，不是"只对这次会话生效"的副本；
 *      所以提示文案里写明了这件事，按钮也直接叫「保存并继续」而不是含糊的"下一步"。
 *   2. **没改动就不写库**：不改也能过，此时按钮是「下一步」，不发 IPC、不顶
 *      `updated_at`（列表按它排序，白写一次会让卡片莫名跳到最前面）。
 *
 * 从角色卡上的「新对话」进入时用 `initialCharacterId`：角色已经定了，就从第 2 步
 * （自定义）开始，少一次无意义的点击——但**自定义这一步不会被跳过**，因为
 * "从卡片进来"恰恰是最可能想微调这张卡的路径。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { Character, Persona, Provider } from '@shared/types.js';
import { Icons } from './Icons.js';
import {
  CharacterForm,
  editPatchOf,
  isDirty,
  type CharacterEditPatch,
} from './CharacterEditor.js';

export interface NewConversationChoice {
  characterId: string;
  personaId: string | null;
  providerId: string;
}

export interface NewConversationWizardProps {
  characters: Character[];
  personas: Persona[];
  providers: Provider[];
  /** 预设角色：设定后直接从「自定义角色信息」那一步开始 */
  initialCharacterId?: string | null;
  /** 全局默认聊天 Provider（settings.chatProviderId），用作预选 */
  defaultProviderId?: string | null;
  /** 第 2 步保存角色卡；返回错误文案表示失败（留在该步显示原因，草稿不丢） */
  onSaveCharacter(character: Character, patch: CharacterEditPatch): Promise<string | null>;
  busy?: boolean;
  error?: string | null;
  onConfirm(choice: NewConversationChoice): void;
  onCancel(): void;
  /** 缺数据时跳去对应页面（向导会被关闭） */
  onGoCharacters(): void;
  onGoPersonas(): void;
  /** 第 4 步缺 Provider：去 API Key 模块（Provider 与密钥的增删改在那里） */
  onGoApiKeys(): void;
}

const STEP_TITLES = ['选择角色', '自定义角色信息', '选择人设', '选择 Key'] as const;
const STEP_CHARACTER = 0;
const STEP_CUSTOMIZE = 1;
const STEP_PERSONA = 2;
const STEP_PROVIDER = 3;

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
  onSaveCharacter,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
  onGoCharacters,
  onGoPersonas,
  onGoApiKeys,
}: NewConversationWizardProps): JSX.Element {
  const presetCharacter = characters.find((c) => c.id === initialCharacterId) ?? null;
  const options = useMemo(() => usableProviders(providers), [providers]);

  const [step, setStep] = useState<number>(presetCharacter ? STEP_CUSTOMIZE : STEP_CHARACTER);
  const [characterId, setCharacterId] = useState<string | null>(presetCharacter?.id ?? null);
  /*
   * 角色草稿与"基线"成对出现：
   *   - `draft` 是表单当前内容（受控）；
   *   - `baseline` 是**已经落库的那一份**，用来判断"改了没有"。
   * 保存成功后把基线挪到草稿上，按钮立刻从「保存并继续」变回「下一步」——
   * 这里刻意不依赖 props 刷新：那是异步的，会让按钮闪一下。
   */
  const [draft, setDraft] = useState<CharacterEditPatch | null>(
    presetCharacter ? editPatchOf(presetCharacter) : null,
  );
  const [baseline, setBaseline] = useState<CharacterEditPatch | null>(
    presetCharacter ? editPatchOf(presetCharacter) : null,
  );
  const [saving, setSaving] = useState(false);
  const [stepError, setStepError] = useState<string | null>(null);

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
  const isLast = step === STEP_PROVIDER;
  const draftCharacter = characterId
    ? (characters.find((c) => c.id === characterId) ?? null)
    : null;
  const dirty = Boolean(draft && baseline && isDirty(baseline, draft));
  const working = busy || saving;

  const canAdvance =
    step === STEP_CHARACTER
      ? Boolean(characterId)
      : step === STEP_CUSTOMIZE
        ? // 名称为空提交不出去：主进程的 `characterUpdateSchema` 要求 min(1)，
          // 与其让用户点下去再吃一个报错，不如按钮就是灰的
          Boolean(draft && draft.name.trim())
        : step === STEP_PERSONA
          ? true
          : Boolean(providerId);

  /** 在第 1 步选角色：草稿与基线一起换成这一张卡。 */
  const chooseCharacter = (id: string): void => {
    const picked = characters.find((c) => c.id === id) ?? null;
    setCharacterId(id);
    setDraft(picked ? editPatchOf(picked) : null);
    setBaseline(picked ? editPatchOf(picked) : null);
    setStepError(null);
  };

  const goNext = (): void => setStep((s) => s + 1);

  /**
   * 第 2 步的主操作：有改动就**先写回角色卡**再进下一步，没改动直接进。
   *
   * 失败留在这一步显示原因——用户刚改了一屏内容，把它丢掉是最差的做法。
   */
  const saveAndContinue = async (): Promise<void> => {
    if (!canAdvance || working) return;
    if (!dirty || !draftCharacter || !draft) {
      goNext();
      return;
    }
    setSaving(true);
    setStepError(null);
    const message = await onSaveCharacter(draftCharacter, draft);
    setSaving(false);
    if (message) {
      setStepError(message);
      return;
    }
    setBaseline(draft);
    goNext();
  };

  const next = (): void => {
    if (isLast) {
      if (!characterId || !providerId) return;
      onConfirm({ characterId, personaId, providerId });
      return;
    }
    if (step === STEP_CUSTOMIZE) {
      void saveAndContinue();
      return;
    }
    goNext();
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
            {step === STEP_CHARACTER ? (
              characters.length ? (
                <ChoiceList
                  label="用哪个角色聊"
                  items={characters.map((c) => ({
                    id: c.id,
                    title: c.name,
                    meta: c.description || '（没有描述）',
                  }))}
                  selectedId={characterId}
                  onSelect={chooseCharacter}
                />
              ) : (
                <EmptyStep
                  hint="角色库还是空的。先导入一张角色卡，才能开始对话。"
                  actionLabel="去角色库导入"
                  onAction={onGoCharacters}
                />
              )
            ) : null}

            {step === STEP_CUSTOMIZE ? (
              draft ? (
                <>
                  <p className="wizard-hint">
                    这一步改的是<b>角色卡本身</b>，所有会话共享。改完点「保存并继续」写回，
                    不想动就直接下一步。
                  </p>
                  <CharacterForm value={draft} onChange={setDraft} />
                </>
              ) : (
                <EmptyStep
                  hint="这张角色卡已经不在库里了。回上一步重新选一个。"
                  actionLabel="回上一步"
                  onAction={() => setStep(STEP_CHARACTER)}
                />
              )
            ) : null}

            {step === STEP_PERSONA ? (
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

            {step === STEP_PROVIDER ? (
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
                  hint="还没有可用的 Provider。先在 API Key 里配置一个 Key 才能开始对话。"
                  actionLabel="去 API Key"
                  onAction={onGoApiKeys}
                />
              )
            ) : null}
          </div>

          {stepError ?? error ? (
            <div className="dialog-error" role="alert">
              {stepError ?? error}
            </div>
          ) : null}

          <div className="actions">
            <button type="button" className="btn" onClick={onCancel} disabled={working}>
              取消
            </button>
            <div className="spacer" />
            {step > 0 ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setStepError(null);
                  setStep((s) => s - 1);
                }}
                disabled={working}
              >
                上一步
              </button>
            ) : null}
            <button
              type="button"
              className="btn primary"
              style={{ width: 'auto' }}
              onClick={next}
              disabled={working || !canAdvance || (isLast && !options.length)}
            >
              {/* 按钮名说真话：有改动才是「保存并继续」，没改动就是普通的「下一步」 */}
              {isLast ? '开始对话' : step === STEP_CUSTOMIZE && dirty ? '保存并继续' : '下一步'}
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
