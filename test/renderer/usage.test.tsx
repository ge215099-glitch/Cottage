// @vitest-environment jsdom
/**
 * 用量页测试。
 *
 * 页面上每个数字的来源都是主进程的 `usage:summary` 返回值，renderer 不做任何统计——
 * 所以这里既不造数据也不重算，只验证"**传对了筛选条件、显示对了收到的值**"。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UsagePage } from '../../src/renderer/components/UsagePage.js';
import { DEFAULT_USAGE_FILTER, useAppStore } from '../../src/renderer/stores/app.js';
import { installFakeApi, makeProvider, makeUsageSummary } from './helpers.js';

afterEach(() => {
  cleanup();
  useAppStore.setState({ usageFilter: { ...DEFAULT_USAGE_FILTER } });
});

interface SetupOptions {
  usage?: Parameters<typeof makeUsageSummary>[0];
  providers?: ReturnType<typeof makeProvider>[];
}

async function setup(options: SetupOptions = {}) {
  const { spies } = installFakeApi({
    providers: options.providers ?? [makeProvider()],
    usage: makeUsageSummary(options.usage),
  });
  useAppStore.setState({ usageFilter: { ...DEFAULT_USAGE_FILTER } });

  const user = userEvent.setup();
  render(<UsagePage providers={options.providers ?? [makeProvider()]} />);
  await waitFor(() => expect(spies['usage.summary']).toHaveBeenCalled());
  return { user, spies };
}

describe('指标卡片', () => {
  it('请求次数、Tokens、输入/输出三张卡都渲染出来', async () => {
    await setup({
      usage: {
        requests: 2569,
        promptTokens: 300_000_000,
        completionTokens: 141_327_744,
        tokens: 441_327_744,
        failedRequests: 12,
        activeDays: 4,
      },
    });

    expect(screen.getByText('API 请求次数')).toBeTruthy();
    expect(screen.getByText('2,569')).toBeTruthy();
    expect(screen.getByText('Tokens')).toBeTruthy();
    expect(screen.getByText('输入 / 输出 Tokens')).toBeTruthy();
    expect(screen.getByText(/其中失败 12 次/)).toBeTruthy();
  });

  it('大数折算成「亿」，同时保留精确值在脚注里', async () => {
    await setup({ usage: { tokens: 441_327_744 } });
    expect(screen.getByText('4.41 亿')).toBeTruthy();
    expect(screen.getByText('441,327,744 个')).toBeTruthy();
  });

  it('估算值挂「约」前缀（估算不得当精确值展示）', async () => {
    await setup({ usage: { tokens: 12_345, anyEstimated: true } });
    expect(screen.getByText(/^约 /)).toBeTruthy();
  });

  it('精确值不挂「约」', async () => {
    await setup({ usage: { tokens: 12_345, anyEstimated: false } });
    expect(screen.queryByText(/^约 /)).toBeNull();
  });

  it('没有消费金额卡片：API 不返回单次费用，不做估算金额', async () => {
    await setup();
    expect(screen.queryByText(/消费金额|金额|余额|CNY|￥/)).toBeNull();
  });
});

describe('筛选', () => {
  it('默认按「本月 + 全部 Key」查询', async () => {
    const { spies } = await setup();
    expect(spies['usage.summary']).toHaveBeenCalledWith({ range: 'month', providerId: null });
  });

  it('切换时间维度会重新查询并带上新的 range', async () => {
    const { user, spies } = await setup();
    await user.selectOptions(screen.getByLabelText('时间维度'), 'week');

    await waitFor(() =>
      expect(spies['usage.summary']).toHaveBeenCalledWith({ range: 'week', providerId: null }),
    );
    expect(useAppStore.getState().usageFilter.range).toBe('week');
  });

  it('切换 API Key 会重新查询并带上 providerId', async () => {
    const { user, spies } = await setup();
    await user.selectOptions(screen.getByLabelText('API Key'), 'prv_1');

    await waitFor(() =>
      expect(spies['usage.summary']).toHaveBeenCalledWith({ range: 'month', providerId: 'prv_1' }),
    );
  });

  it('「清除筛选条件」回到默认；默认状态下它是禁用的', async () => {
    const { user, spies } = await setup();
    expect((screen.getByRole('button', { name: '清除筛选条件' }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await user.selectOptions(screen.getByLabelText('时间维度'), 'year');
    const clear = screen.getByRole('button', { name: '清除筛选条件' });
    expect((clear as HTMLButtonElement).disabled).toBe(false);

    await user.click(clear);
    expect(useAppStore.getState().usageFilter).toEqual(DEFAULT_USAGE_FILTER);
    await waitFor(() =>
      expect(spies['usage.summary']).toHaveBeenLastCalledWith({ range: 'month', providerId: null }),
    );
  });

  it('从 API Key 页带过来的 providerId 会被页头文案读出来', async () => {
    installFakeApi({
      providers: [makeProvider({ id: 'prv_1', name: '本地端点' })],
      usage: makeUsageSummary(),
    });
    useAppStore.setState({ usageFilter: { range: 'month', providerId: 'prv_1' } });
    render(<UsagePage providers={[makeProvider({ id: 'prv_1', name: '本地端点' })]} />);

    expect(await screen.findByText(/本地端点 ·/)).toBeTruthy();
  });
});

describe('图表与明细', () => {
  it('每天一根柱子；没有请求的那天也占位', async () => {
    await setup({
      usage: {
        daily: [
          { day: '2026-10-01', requests: 0, promptTokens: 0, completionTokens: 0, tokens: 0 },
          { day: '2026-10-02', requests: 3, promptTokens: 600, completionTokens: 300, tokens: 900 },
          { day: '2026-10-03', requests: 1, promptTokens: 200, completionTokens: 100, tokens: 300 },
        ],
      },
    });

    const chart = screen.getByRole('img', { name: /每日 Tokens 柱状图/ });
    const bars = chart.querySelectorAll('.chart-bar');
    expect(bars).toHaveLength(3);
    expect(bars[0]!.className).toContain('empty');
    expect(bars[1]!.getAttribute('title')).toContain('900 tokens');
  });

  it('模型明细表按主进程给的顺序渲染，不在前端重排', async () => {
    await setup({
      usage: {
        models: [
          { model: 'deepseek-reasoner', requests: 5, promptTokens: 10, completionTokens: 20, tokens: 30 },
          { model: 'deepseek-chat', requests: 2, promptTokens: 1, completionTokens: 1, tokens: 2 },
        ],
      },
    });

    const table = screen.getByRole('table', { name: '按模型统计' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual([
      'deepseek-reasoner',
      'deepseek-chat',
    ]);
  });

  it('区间内没有请求时给空态，并说明怎么让数字出现', async () => {
    await setup({
      usage: {
        daily: [],
        models: [],
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        tokens: 0,
      },
    });
    expect(screen.getByText(/这个区间还没有请求/)).toBeTruthy();
  });

  it('页脚说明统计口径是"本机这个应用"，不与账单口径混为一谈', async () => {
    await setup();
    expect(screen.getByText(/本机这个应用/)).toBeTruthy();
    expect(screen.getByText(/不联网、不上传/)).toBeTruthy();
  });
});

describe('失败分支', () => {
  it('主进程返回失败时显示可读原因，而不是空白页', async () => {
    installFakeApi({
      overrides: {
        'usage.summary': async () => ({
          ok: false,
          error: { code: 'DB_ERROR', message: '数据库读不动了', retryable: false },
        }),
      },
    });
    render(<UsagePage providers={[makeProvider()]} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('读取用量失败');
    expect(alert.textContent).toContain('数据库读不动了');
  });
});
