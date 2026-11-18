/**
 * 角色卡编辑：**一份表单，两种外壳**。
 *
 * 拆成"内容"与"外壳"两层是被两个需求一起逼出来的：
 *
 *   1. 「编辑角色卡」以前是**整页视图**——点一下编辑，角色库整页被替换掉，
 *      保存/取消之后再从网格里把自己找回来。UI 文档第 6 节的入口总表写的
 *      一直是「编辑角色卡 → **大对话框**」，实现没对齐。整页视图换成弹窗之后，
 *      `CharacterEditorDialog` 就是那个"大对话框"。
 *   2. 「新建对话」向导要在选完角色之后插一步「自定义角色信息」，而它要的正是
 *      **同一个编辑面板**。整页视图塞不进向导，所以表单必须是可复用的内容层：
 *      `CharacterForm` 是内容，弹窗外壳与向导步骤各给它套一个壳。
 *
 * 表单是**受控**的（草稿由外壳持有），这是上面两条能同时成立的前提：弹窗要能在
 * 保存失败时留在原地、内容不丢；向导要能把草稿一路带到「开始对话」。
 *
 * 表单只碰**可编辑字段**（产品设计文档 3.2 的清单）。`raw_json` 不在其中——
 * 它是第三方字段的唯一载体，导出时以它为基底，绝不能从这张表单写回；
 * `favorite` / `avatarPath` 也各有自己的入口（卡片角标、导入 PNG 卡）。
 */
import { useRef, useState } from 'react';
import type { JSX, RefObject } from 'react';
import type { Character } from '@shared/types.js';
import { ScrimDialog } from './Overlays.js';

/**
 * 可编辑字段（产品设计文档 3.2 的清单）。
 *
 * 刻意**不是** `Partial<Character>`：那样写的话，谁都可以顺手把 `favorite` 或
 * `avatarPath` 塞进来，而这两个字段写错了是要出事的（收藏状态会被当成普通字段覆盖）。
 */
export interface CharacterEditPatch {
  name: string;
  description: string;
  personality: string;
  scenario: string;
  firstMes: string;
  alternateGreetings: string[];
  mesExample: string;
  systemPrompt: string;
  postHistoryInstructions: string;
  tags: string[];
}

/** 表单里可以当纯文本编辑的字段（`alternateGreetings` / `tags` 是数组，单列处理）。 */
type TextFieldKey = Exclude<keyof CharacterEditPatch, 'alternateGreetings' | 'tags'>;

/** 取角色卡当前的可编辑内容，作为草稿的起点。 */
export function editPatchOf(character: Character): CharacterEditPatch {
  return {
    name: character.name,
    description: character.description,
    personality: character.personality,
    scenario: character.scenario,
    firstMes: character.firstMes,
    alternateGreetings: [...character.alternateGreetings],
    mesExample: character.mesExample,
    systemPrompt: character.systemPrompt,
    postHistoryInstructions: character.postHistoryInstructions,
    tags: [...character.tags],
  };
}

/**
 * 草稿相对起点有没有改动。
 *
 * 存在理由是"**别白写一次库**"：向导里那一步不改也能过，没改动时既不该发 IPC，
 * 也不该把 `updated_at` 顶掉——角色列表按 `updated_at DESC` 排序，白写一次会让
 * 这张卡莫名其妙跳到最前面，看起来像"我刚编辑过它"。
 *
 * 数组按内容比：`['a'] !== ['a']`，比引用会把"没改"判成"改了"。
 */
export function isDirty(baseline: CharacterEditPatch, draft: CharacterEditPatch): boolean {
  const textKeys: TextFieldKey[] = [
    'name',
    'description',
    'personality',
    'scenario',
    'firstMes',
    'mesExample',
    'systemPrompt',
    'postHistoryInstructions',
  ];
  if (textKeys.some((key) => baseline[key] !== draft[key])) return true;
  return (
    baseline.alternateGreetings.join('\n') !== draft.alternateGreetings.join('\n') ||
    baseline.tags.join(',') !== draft.tags.join(',')
  );
}

/* ------------------------------------------------------------------ */
/* 表单内容                                                            */
/* ------------------------------------------------------------------ */

export interface CharacterFormProps {
  value: CharacterEditPatch;
  onChange(next: CharacterEditPatch): void;
  /** 弹窗外壳用它把焦点落在名称输入框；向导步骤不该抢焦点，所以是可选的 */
  firstFieldRef?: RefObject<HTMLInputElement | null>;
}

/**
 * 角色卡表单本体（不含外壳）。
 *
 * 字段与提示文案与产品设计文档 3.2 一致；`system_prompt` 留空的含义是
 * "用描述/性格/场景拼接"，所以那个提示必须留在标签里，不能省。
 */
export function CharacterForm({ value, onChange, firstFieldRef }: CharacterFormProps): JSX.Element {
  const text = (
    key: TextFieldKey,
    label: string,
    hint?: string,
    rows?: number,
  ): JSX.Element => (
    <div className="field">
      <label htmlFor={`f-${key}`}>
        {label}
        {hint ? <span className="sub">（{hint}）</span> : null}
      </label>
      {rows ? (
        <textarea
          id={`f-${key}`}
          value={value[key]}
          rows={rows}
          onChange={(event) => onChange({ ...value, [key]: event.target.value })}
        />
      ) : (
        <input
          ref={key === 'name' ? firstFieldRef : undefined}
          id={`f-${key}`}
          type="text"
          value={value[key]}
          onChange={(event) => onChange({ ...value, [key]: event.target.value })}
        />
      )}
    </div>
  );

  return (
    <>
      <div className="editor-grid">
        {text('name', '名称')}
        {text('description', '描述', 'system_prompt 为空时用于拼接', 4)}
        {text('personality', '性格', undefined, 3)}
        {text('scenario', '场景', undefined, 3)}
        {text('firstMes', '开场白 first_mes', undefined, 3)}
        {text('systemPrompt', 'system_prompt', '留空则用描述/性格/场景拼接', 4)}
        {text('postHistoryInstructions', 'post_history_instructions', undefined, 3)}
        {text('mesExample', '示例对话 mes_example', '用 {{user}}: / {{char}}: 标记', 5)}
      </div>

      <div className="field" style={{ marginTop: 12 }}>
        <label htmlFor="f-tags">标签（逗号分隔）</label>
        <input
          id="f-tags"
          type="text"
          value={value.tags.join(', ')}
          onChange={(event) =>
            onChange({
              ...value,
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
          value={value.alternateGreetings.join('\n')}
          onChange={(event) =>
            onChange({
              ...value,
              alternateGreetings: event.target.value
                .split('\n')
                .map((s) => s.trim())
                .filter(Boolean),
            })
          }
        />
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 弹窗外壳                                                            */
/* ------------------------------------------------------------------ */

export interface CharacterEditorDialogProps {
  character: Character;
  onClose(): void;
  /** 返回错误文案表示失败（失败时弹窗留在原地、草稿不丢） */
  onSave(character: Character, patch: CharacterEditPatch): Promise<string | null>;
}

/**
 * 「编辑角色卡」大对话框。
 *
 * 两条行为是刻意的（都是以前整页视图里真实存在的问题）：
 *
 *   1. **名称为空时「保存」是禁用的**。以前没有这道闸：点保存先把整页切走，
 *      主进程那边 `角色名不能为空` 才报错，结果是"只弹一个 toast，刚编辑的一屏
 *      内容全丢"。现在空名称根本提交不出去，失败也留在弹窗里显示原因。
 *   2. **保存成功才关**。失败关掉弹窗等于把用户输的内容扔掉，这是最差的做法
 *      （人设 / API Key 两个弹窗也是这个口径）。
 */
export function CharacterEditorDialog({
  character,
  onClose,
  onSave,
}: CharacterEditorDialogProps): JSX.Element {
  const [draft, setDraft] = useState<CharacterEditPatch>(() => editPatchOf(character));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  const canSave = draft.name.trim().length > 0 && !saving;

  const submit = async (): Promise<void> => {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    const message = await onSave(character, draft);
    setSaving(false);
    if (message) {
      setError(message);
      return;
    }
    onClose();
  };

  return (
    <ScrimDialog
      title={`编辑角色卡：${character.name}`}
      className="char-editor"
      initialFocusRef={firstFieldRef}
      onClose={saving ? () => undefined : onClose}
      footer={
        <>
          <div className="spacer" />
          <button type="button" className="btn" disabled={saving} onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn primary"
            style={{ width: 'auto' }}
            disabled={!canSave}
            onClick={() => void submit()}
          >
            保存
          </button>
        </>
      }
    >
      <p>改动会写回角色卡；原卡的第三方字段仍然原样保留（导出时以 raw_json 为基底）。</p>
      <div className="char-editor-body">
        <CharacterForm value={draft} onChange={setDraft} firstFieldRef={firstFieldRef} />
      </div>
      {error ? (
        <div className="dialog-error" role="alert">
          {error}
        </div>
      ) : null}
    </ScrimDialog>
  );
}
