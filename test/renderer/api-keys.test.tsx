// @vitest-environment jsdom
/** 模型连接的紧凑展示与原有创建、编辑、测试和删除行为。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiKeysPage } from '../../src/renderer/components/ApiKeysPage.js';
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

describe('紧凑连接列表', () => {
  it('仅显示名称、状态和操作，不展示配置详情或日期', () => {
    setup([makeProvider({ name: '本地 DeepSeek', lastUsedAt: T0 + 86_400_000 })]);
    const list = screen.getByRole('list', { name: '模型连接列表' });
    expect(within(list).getByText('本地 DeepSeek')).toBeTruthy();
    expect(within(list).getByText('已启用')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(list.textContent).not.toContain('api.example.invalid');
    expect(list.textContent).not.toContain('deepseek-chat');
    expect(list.textContent).not.toContain('创建日期');
    expect(list.textContent).not.toContain('sk-');
  });
  it('页面上不存在常驻的添加表单', () => {
    setup();
    expect(screen.queryByLabelText('名称')).toBeNull();
    expect(screen.queryByLabelText('base_url')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  it('没有密钥时显示简短状态并禁用测试', () => {
    setup([makeProvider({ hasKey: false })]);
    expect(screen.getByText('未配置密钥')).toBeTruthy();
    expect((screen.getByRole('button', { name: '测试' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('未使用过的连接也不显示日期占位', () => {
    setup([makeProvider({ lastUsedAt: null })]);
    expect(screen.queryByText('—')).toBeNull();
  });
  it('空列表给出可读空态', () => {
    setup([]);
    expect(screen.queryByRole('list', { name: '模型连接列表' })).toBeNull();
    expect(screen.getByText(/还没有 API Key/)).toBeTruthy();
  });
  it('成功结果只显示简短提示，不显示 HTTP 或供应商原始消息', () => {
    setup([makeProvider()], { testResults: { prv_1: { outcome: 'ok', httpStatus: 200, probe: 'models', message: '可达，鉴权通过，发现 2 个模型', models: ['deepseek-chat'], storageWarning: null } } });
    expect(screen.getByRole('status').textContent).toBe('测试通过');
    expect(screen.queryByText(/HTTP|发现 2 个模型|可达/)).toBeNull();
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

  it('鉴权失败仅显示简短提示', () => {
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
    expect(screen.getByRole('status').textContent).toBe('鉴权失败');
    expect(screen.queryByText(/HTTP/)).toBeNull();
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
    await user.click(screen.getByRole('button', { name: '查看用量' }));
    expect(onViewUsage).toHaveBeenCalledWith(expect.objectContaining({ id: 'prv_1' }));
  });

  it('一把 Key 都没有时按钮禁用（跳过去也没有可筛的东西）', () => {
    setup([]);
    expect(
      (screen.getByRole('button', { name: '查看用量' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
