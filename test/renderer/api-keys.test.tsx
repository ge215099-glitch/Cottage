// @vitest-environment jsdom
/**
 * API Key 页（导航模块）测试。
 *
 * 守三条交互约定，它们都是这次改版的核心诉求：
 *   1. **添加/编辑走弹窗**，页面上不常驻表单（"添加面板不要直接放在页面上"）；
 *   2. **密钥列是掩码**，不是真 Key 也不是空（renderer 根本拿不到真值）；
 *   3. **删除是破坏性操作**，必须确认，并说明会牵连会话绑定。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiKeysPage, KEY_MASK } from '../../src/renderer/components/ApiKeysPage.js';
import { makeProvider, T0 } from './helpers.js';
import type { Provider, ProviderTestResult } from '../../src/shared/types.js';

afterEach(cleanup);

interface Handlers {
  onTest: ReturnType<typeof vi.fn>;
  onSave: ReturnType<typeof vi.fn>;
  onDelete: ReturnType<typeof vi.fn>;
  onViewUsage: ReturnType<typeof vi.fn>;
}

function setup(
  providers: Provider[] = [makeProvider()],
  options: {
    testResults?: Record<string, ProviderTestResult>;
    busyId?: string | null;
  } = {},
): Handlers {
  const onTest = vi.fn(async () => undefined);
  const onSave = vi.fn(async () => null);
  const onDelete = vi.fn();
  const onViewUsage = vi.fn();

  render(
    <ApiKeysPage
      providers={providers}
      busyId={options.busyId ?? null}
      testResults={options.testResults ?? {}}
      onTest={onTest}
      onSave={onSave}
      onDelete={onDelete}
      onViewUsage={onViewUsage}
    />,
  );
  return { onTest, onSave, onDelete, onViewUsage };
}

describe('列表', () => {
  it('每行显示名称 / 状态 / Key / 创建日期 / 最新使用日期', () => {
    setup([makeProvider({ name: '本地 DeepSeek', lastUsedAt: T0 + 86_400_000 })]);

    const table = screen.getByRole('table', { name: 'API Key 列表' });
    for (const header of ['名称', '状态', 'Key', '创建日期', '最新使用日期']) {
      expect(within(table).getByRole('columnheader', { name: header })).toBeTruthy();
    }
    expect(within(table).getByText('本地 DeepSeek')).toBeTruthy();
    expect(within(table).getByText('已启用')).toBeTruthy();
  });

  it('页面上不存在常驻的添加表单（element 只在弹窗里出现）', () => {
    setup();
    expect(screen.queryByLabelText('名称')).toBeNull();
    expect(screen.queryByLabelText('base_url')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('没有配置 Key 的行显示「未配置 Key」，而不是空单元格', () => {
    setup([makeProvider({ hasKey: false })]);
    expect(screen.getByText('未配置 Key')).toBeTruthy();
    expect(screen.queryByText(KEY_MASK)).toBeNull();
  });

  it('从未用过的 Key，最新使用日期显示「—」', () => {
    setup([makeProvider({ lastUsedAt: null })]);
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('空列表给出可读空态，而不是一张空表', () => {
    setup([]);
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getByText(/还没有 API Key/)).toBeTruthy();
  });
});

describe('密钥掩码', () => {
  it('已配置 Key 的行只渲染固定掩码，不含任何真实片段', () => {
    setup([makeProvider({ name: '本地端点' })]);
    const code = screen.getByText(KEY_MASK);
    expect(code.textContent).toBe(KEY_MASK);
    // 掩码是固定字面量：不含 base_url、id、名字里的任何内容
    expect(code.textContent).not.toContain('prv_1');
    expect(code.textContent).not.toContain('api.example.invalid');
  });
});

describe('创建 / 编辑弹窗', () => {
  it('「创建 API Key」打开弹窗，关闭前不发起保存', async () => {
    const user = userEvent.setup();
    const { onSave } = setup();

    await user.click(screen.getByRole('button', { name: '创建 API Key' }));
    expect(screen.getByRole('dialog', { name: '创建 API Key' })).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('填完表单点「创建」把解析后的模型列表提交上去', async () => {
    const user = userEvent.setup();
    const { onSave } = setup();

    await user.click(screen.getByRole('button', { name: '创建 API Key' }));
    await user.type(screen.getByLabelText('名称'), '备用端点');
    await user.type(screen.getByLabelText('base_url'), 'https://b.invalid/v1');
    await user.type(screen.getByLabelText('API Key'), 'sk-test');
    await user.type(screen.getByLabelText(/模型列表/), 'deepseek-chat, deepseek-reasoner');
    await user.type(screen.getByLabelText('默认模型'), 'deepseek-chat');
    await user.click(screen.getByRole('button', { name: '创建' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    expect(onSave).toHaveBeenCalledWith({
      name: '备用端点',
      type: 'openai',
      baseUrl: 'https://b.invalid/v1',
      apiKey: 'sk-test',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      defaultModel: 'deepseek-chat',
      compressionModel: 'deepseek-chat',
      enabled: true,
    });
    // 成功后弹窗自动关闭
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('名称为空时「创建」是禁用的（不提交半截配置）', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: '创建 API Key' }));
    expect((screen.getByRole('button', { name: '创建' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('编辑时密钥留空：不提交 apiKey 字段（表示不改动已保存的 Key）', async () => {
    const user = userEvent.setup();
    const { onSave } = setup([makeProvider({ name: '本地端点' })]);

    await user.click(screen.getByRole('button', { name: '编辑 本地端点' }));
    expect(screen.getByRole('dialog', { name: '编辑 API Key：本地端点' })).toBeTruthy();

    await user.click(screen.getByRole('button', { name: '保存修改' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));
    const payload = onSave.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload['id']).toBe('prv_1');
    expect('apiKey' in payload).toBe(false);
  });

  it('保存失败时留在弹窗里就地报错，不丢用户已填的内容', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(async () => '入参校验失败：baseUrl 太短');
    render(
      <ApiKeysPage
        providers={[makeProvider()]}
        busyId={null}
        testResults={{}}
        onTest={vi.fn(async () => undefined)}
        onSave={onSave}
        onDelete={vi.fn()}
        onViewUsage={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: '创建 API Key' }));
    await user.type(screen.getByLabelText('名称'), '备用端点');
    await user.type(screen.getByLabelText('base_url'), 'https://b.invalid/v1');
    await user.click(screen.getByRole('button', { name: '创建' }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('入参校验失败'),
    );
    expect(screen.getByRole('dialog', { name: '创建 API Key' })).toBeTruthy();
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('备用端点');
  });

  it('Esc 关闭弹窗', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(screen.getByRole('button', { name: '创建 API Key' }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});

describe('测试与删除', () => {
  it('「测试」在测试期间显示进行中状态，且不重复触发', async () => {
    setup([makeProvider()], { busyId: 'prv_1' });
    expect(screen.getByRole('button', { name: '测试中…' })).toBeTruthy();
    expect((screen.getByRole('button', { name: '测试中…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('「测试」把 provider id 交给上层（结果由上层持有，切页也不丢）', async () => {
    const user = userEvent.setup();
    const { onTest } = setup([makeProvider()]);
    await user.click(screen.getByRole('button', { name: '测试' }));
    expect(onTest).toHaveBeenCalledWith('prv_1');
  });

  it('已有测试结果时在行内显示三态文案', () => {
    setup([makeProvider({ name: '本地端点' })], {
      testResults: {
        prv_1: {
          outcome: 'auth-failed',
          httpStatus: 401,
          probe: 'models',
          message: '鉴权失败',
          models: [],
          storageWarning: null,
        },
      },
    });
    expect(screen.getByText(/可达，鉴权失败（HTTP 401）/)).toBeTruthy();
  });

  it('没有 Key 时测试按钮禁用（测试必然失败，不该让用户白点）', () => {
    setup([makeProvider({ hasKey: false })]);
    expect((screen.getByRole('button', { name: '测试' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('删除走确认回调，不自己直接删', async () => {
    const user = userEvent.setup();
    const { onDelete } = setup([makeProvider({ name: '本地端点' })]);

    await user.click(screen.getByRole('button', { name: '删除 本地端点' }));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'prv_1' }));
  });

  it('编辑弹窗里的「删除」也走同一个确认回调', async () => {
    const user = userEvent.setup();
    const { onDelete } = setup([makeProvider({ name: '本地端点' })]);

    await user.click(screen.getByRole('button', { name: '编辑 本地端点' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: '删除' }));
    expect(onDelete).toHaveBeenCalledWith(expect.objectContaining({ id: 'prv_1' }));
  });
});

describe('按 API Key 查看用量', () => {
  it('按钮把当前第一条 Key 交给用量页', async () => {
    const user = userEvent.setup();
    const { onViewUsage } = setup([makeProvider({ name: '本地端点' })]);
    await user.click(screen.getByRole('button', { name: '按 API Key 查看用量' }));
    expect(onViewUsage).toHaveBeenCalledWith(expect.objectContaining({ id: 'prv_1' }));
  });

  it('一把 Key 都没有时按钮禁用（跳过去也没有可筛的东西）', () => {
    setup([]);
    expect(
      (screen.getByRole('button', { name: '按 API Key 查看用量' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
