// @vitest-environment jsdom
/**
 * 「新建对话」向导的组件测试。
 *
 * 交互契约（用户明确要求的那套）：**选角色 → 选人设 → 选 Key → 才开始对话**，
 * 每一步都要显式确认。这里守住四件事：
 *   1. 步骤顺序与"必须确认才能进入下一步"；
 *   2. 预选值是可见的（人设取全局默认、Provider 取设置的默认聊天 Provider），
 *      正常路径一路确认即可，不需要为了通过而多点；
 *   3. 从角色卡的「新对话」进来时跳过第 1 步（角色已定）；
 *   4. 某一步缺数据时给出**明确的下一步动作**，而不是让按钮静默变灰。
 */
import { describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach } from 'vitest';
import {
  NewConversationWizard,
  type NewConversationWizardProps,
} from '../../src/renderer/components/NewConversationWizard.js';
import { makeCharacter, makePersona, makeProvider } from './helpers.js';

afterEach(cleanup);

function setup(overrides: Partial<NewConversationWizardProps> = {}) {
  const props: NewConversationWizardProps = {
    characters: [makeCharacter(), makeCharacter({ id: 'chr_2', name: '鲍勃' })],
    personas: [makePersona(), makePersona({ id: 'per_2', name: '旅人', isDefault: false })],
    providers: [makeProvider(), makeProvider({ id: 'prv_2', name: '备用端点', hasKey: false })],
    defaultProviderId: 'prv_1',
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    onGoCharacters: vi.fn(),
    onGoPersonas: vi.fn(),
    onGoApiKeys: vi.fn(),
    ...overrides,
  };
  const view = render(<NewConversationWizard {...props} />);
  return { props, view };
}

const stepLabel = (n: number): string => `第 ${n} 步 / 共 3 步`;

describe('新建对话向导', () => {
  it('第一步是选角色，未选之前「下一步」不可用', async () => {
    const user = userEvent.setup();
    const { props } = setup();

    expect(screen.getByText(new RegExp(stepLabel(1)))).toBeTruthy();
    expect(screen.getByRole('radiogroup', { name: '用哪个角色聊' })).toBeTruthy();
    const next = screen.getByRole('button', { name: '下一步' });
    expect((next as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByRole('radio', { name: /爱丽丝/ }));
    expect((next as HTMLButtonElement).disabled).toBe(false);
    await user.click(next);
    expect(screen.getByText(new RegExp(stepLabel(2)))).toBeTruthy();
    expect(props.onConfirm).not.toHaveBeenCalled();
  });

  it('第二步选人设，全局默认人设已被预选', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('radio', { name: /爱丽丝/ }));
    await user.click(screen.getByRole('button', { name: '下一步' }));

    expect(screen.getByRole('radiogroup', { name: '你是谁（人设）' })).toBeTruthy();
    // 默认人设预选：用户只需要确认
    expect(screen.getByRole('radio', { name: /ASMobbin/ }).getAttribute('aria-checked')).toBe('true');
    expect(screen.getByRole('radio', { name: /旅人/ }).getAttribute('aria-checked')).toBe('false');
  });

  it('第三步选 Key，默认聊天 Provider 已预选，确认后回传三项选择', async () => {
    const user = userEvent.setup();
    const { props } = setup();

    await user.click(screen.getByRole('radio', { name: /爱丽丝/ }));
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.click(screen.getByRole('radio', { name: /旅人/ }));
    await user.click(screen.getByRole('button', { name: '下一步' }));

    expect(screen.getByText(new RegExp(stepLabel(3)))).toBeTruthy();
    expect(screen.getByRole('radio', { name: /本地端点/ }).getAttribute('aria-checked')).toBe('true');
    // 密钥状态要可见：选 Key 的时候必须能看出哪个已存了密钥
    expect(screen.getByText(/密钥已保存/)).toBeTruthy();
    expect(screen.getByText(/未保存密钥/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '开始对话' }));
    expect(props.onConfirm).toHaveBeenCalledWith({
      characterId: 'chr_1',
      personaId: 'per_2',
      providerId: 'prv_1',
    });
  });

  it('从角色卡的「新对话」进来时跳过选角色，直接进选人设', () => {
    setup({ initialCharacterId: 'chr_2' });
    expect(screen.getByText(new RegExp(stepLabel(2)))).toBeTruthy();
    expect(screen.queryByRole('radiogroup', { name: '用哪个角色聊' })).toBeNull();
  });

  it('可以回上一步改角色，选择不丢', async () => {
    const user = userEvent.setup();
    setup({ initialCharacterId: 'chr_2' });
    await user.click(screen.getByRole('button', { name: '上一步' }));
    expect(screen.getByText(new RegExp(stepLabel(1)))).toBeTruthy();
    expect(screen.getByRole('radio', { name: /鲍勃/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('取消与 Esc 都会关闭向导', async () => {
    const user = userEvent.setup();
    const { props } = setup();
    await user.click(screen.getByRole('button', { name: '取消' }));
    expect(props.onCancel).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    expect(props.onCancel).toHaveBeenCalledTimes(2);
  });

  it('停用的 Provider 不出现在选 Key 里', () => {
    setup({
      providers: [makeProvider(), makeProvider({ id: 'prv_off', name: '停用端点', enabled: false })],
    });
    expect(screen.queryByRole('radio', { name: /停用端点/ })).toBeNull();
  });

  it('没有角色时给出「去角色库导入」，而不是留一个灰按钮', async () => {
    const user = userEvent.setup();
    const { props } = setup({ characters: [] });
    expect(screen.getByText(/角色库还是空的/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '下一步' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: '去角色库导入' }));
    expect(props.onGoCharacters).toHaveBeenCalled();
  });

  it('没有 Provider 时不能开始对话，并给出「去 API Key」', async () => {
    const user = userEvent.setup();
    const { props } = setup({ providers: [] });
    await user.click(screen.getByRole('radio', { name: /爱丽丝/ }));
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.click(screen.getByRole('button', { name: '下一步' }));

    expect(screen.getByText(/还没有可用的 Provider/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '开始对话' }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole('button', { name: '去 API Key' }));
    expect(props.onGoApiKeys).toHaveBeenCalled();
  });

  it('没有人设时仍可继续（人设是可选的），并给出「去创建人设」', async () => {
    const user = userEvent.setup();
    const { props } = setup({ personas: [] });
    await user.click(screen.getByRole('radio', { name: /爱丽丝/ }));
    await user.click(screen.getByRole('button', { name: '下一步' }));

    expect(screen.getByText(/还没有人设/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: '去创建人设' }));
    expect(props.onGoPersonas).toHaveBeenCalled();
  });

  it('建库失败时留在向导里显示原因（不让用户重选一遍）', () => {
    setup({ error: '数据库忙', busy: false });
    expect(screen.getByText('数据库忙')).toBeTruthy();
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
  });

  it('正在创建时按钮禁用，避免重复提交', async () => {
    const user = userEvent.setup();
    const { props, view } = setup();
    // 先走到最后一步（busy 只在提交期间为真，所以要在第 3 步上再切换）
    await user.click(screen.getByRole('radio', { name: /爱丽丝/ }));
    await user.click(screen.getByRole('button', { name: '下一步' }));
    await user.click(screen.getByRole('button', { name: '下一步' }));
    expect(screen.getByRole('button', { name: '开始对话' })).toBeTruthy();

    view.rerender(<NewConversationWizard {...props} busy />);
    expect((screen.getByRole('button', { name: '开始对话' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '取消' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '上一步' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
