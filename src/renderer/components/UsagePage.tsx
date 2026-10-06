/**
 * 用量模块（导航项「用量」）。
 *
 * 形态参考 DeepSeek 开放平台的「用量信息」页：**过滤行 + 指标卡 + 按天柱状图 + 明细表**。
 *
 * 与参考页的三处有意偏离，都写在界面上而不是藏在代码里：
 *
 * 1. **没有「消费金额」**。API 不返回单次请求花了多少钱，要算金额就得维护一张
 *    会过期的单价表。与其显示一个看着精确、实则靠猜的数字，不如只报 token 与请求数。
 * 2. **没有「账户余额」**。`/user/balance` 是 DeepSeek 专有接口，别的 OpenAI 兼容端点没有；
 *    为一个 Key 显示余额、另一个显示报错，比没有这个卡片更让人困惑。
 * 3. **过滤维度只有时间与 Key**。参考页还能按模型筛，但模型明细表已经把模型维度
 *    摊开在同一屏里了，再加一个下拉是重复入口。
 *
 * 数据源是本地消息元数据的派生投影，口径写在页脚：**统计的是本应用在这台机器上
 * 发出的请求**，与账号后台的账单（含其它客户端、赠金抵扣、缓存命中折扣）本来就不会
 * 完全一致。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import type { Provider, UsageDailyPoint, UsageRangeKey, UsageSummary } from '@shared/types.js';
import {
  USAGE_RANGE_KEYS,
  USAGE_RANGE_LABELS,
  usageAxisMax,
  usageAxisTicks,
} from '@core/usage/index.js';
import { useAppStore } from '../stores/app.js';
import { formatDay } from './ApiKeysPage.js';

export interface UsagePageProps {
  providers: Provider[];
}

const api = (): Window['cottage'] => window.cottage;

/** 千分位。renderer 侧只做展示格式化，不做任何统计口径判断。 */
function count(value: number): string {
  return value.toLocaleString('en-US');
}

/** 卡片上的大数：过万折成「万/亿」，避免 4.4 亿这个数量级把卡片撑爆。 */
function compact(value: number): string {
  if (value < 10_000) return count(value);
  if (value < 100_000_000) return `${(value / 10_000).toFixed(2)} 万`;
  return `${(value / 100_000_000).toFixed(2)} 亿`;
}

export function UsagePage({ providers }: UsagePageProps): JSX.Element {
  const filter = useAppStore((s) => s.usageFilter);
  const setUsageFilter = useAppStore((s) => s.setUsageFilter);
  const resetUsageFilter = useAppStore((s) => s.resetUsageFilter);

  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await api().usage.summary({
      range: filter.range,
      providerId: filter.providerId,
    });
    if (result.ok) {
      setSummary(result.data);
      setError(null);
    } else {
      setError(result.error.message);
    }
    setLoading(false);
  }, [filter.range, filter.providerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const providerName = useMemo(() => {
    if (!filter.providerId) return '全部 Key';
    return providers.find((p) => p.id === filter.providerId)?.name ?? '（已删除的 Key）';
  }, [filter.providerId, providers]);

  const peak = useMemo(
    () => (summary ? summary.daily.reduce((m, d) => (d.tokens > m ? d.tokens : m), 0) : 0),
    [summary],
  );
  const axisMax = useMemo(() => usageAxisMax(peak), [peak]);
  const ticks = useMemo(() => usageAxisTicks(summary?.daily ?? []), [summary]);

  const filtered = filter.range !== 'month' || filter.providerId !== null;

  return (
    <div className="page">
      <div className="page-inner">
        <h1>用量</h1>

        <div className="filter-bar">
          <label className="sr-only" htmlFor="usage-range">
            时间维度
          </label>
          <select
            id="usage-range"
            value={filter.range}
            onChange={(event) =>
              setUsageFilter({ range: event.target.value as UsageRangeKey })
            }
          >
            {USAGE_RANGE_KEYS.map((key) => (
              <option key={key} value={key}>
                {USAGE_RANGE_LABELS[key]}
              </option>
            ))}
          </select>

          <label className="sr-only" htmlFor="usage-provider">
            API Key
          </label>
          <select
            id="usage-provider"
            value={filter.providerId ?? ''}
            onChange={(event) => setUsageFilter({ providerId: event.target.value || null })}
          >
            <option value="">全部 Key</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>

          <button
            type="button"
            className="clear-filters"
            disabled={!filtered}
            onClick={() => resetUsageFilter()}
          >
            清除筛选条件
          </button>
        </div>

        {error ? (
          <div className="page-error" role="alert">
            <b>读取用量失败：</b>
            {error}
          </div>
        ) : null}

        {loading && !summary ? (
          <div className="sub">正在统计…</div>
        ) : summary ? (
          <>
            <div className="metric-grid">
              <div className="metric-card">
                <div className="metric-label">API 请求次数</div>
                <div className="metric-value">{count(summary.requests)}</div>
                <div className="metric-foot">
                  {summary.failedRequests
                    ? `其中失败 ${count(summary.failedRequests)} 次 · 有请求的 ${summary.activeDays} 天`
                    : `有请求的 ${summary.activeDays} 天`}
                </div>
              </div>
              <div className="metric-card">
                <div className="metric-label">Tokens</div>
                <div className="metric-value">
                  {summary.anyEstimated ? '约 ' : ''}
                  {compact(summary.tokens)}
                </div>
                <div className="metric-foot">{count(summary.tokens)} 个</div>
              </div>
              <div className="metric-card">
                <div className="metric-label">输入 / 输出 Tokens</div>
                <div className="metric-value">
                  {compact(summary.promptTokens)} / {compact(summary.completionTokens)}
                </div>
                <div className="metric-foot">
                  {summary.reasoningRequests
                    ? `含 ${count(summary.reasoningRequests)} 次带思考的输出`
                    : '按上游回报的用量统计'}
                </div>
              </div>
            </div>

            <div className="chart-card">
              <div className="chart-head">
                <span className="chart-title">每日 Tokens</span>
                <span className="chart-note">
                  {providerName} · {formatDay(summary.from)} → {formatDay(summary.to)} · 上限{' '}
                  {count(axisMax)}
                </span>
              </div>
              <div className="chart-plot" role="img" aria-label={`每日 Tokens 柱状图，共 ${summary.daily.length} 天`}>
                <div className="chart-gridlines" aria-hidden="true">
                  <span>{count(axisMax)}</span>
                  <span>{count(axisMax / 2)}</span>
                  <span>0</span>
                </div>
                {summary.daily.map((point) => (
                  <Bar key={point.day} point={point} peak={peak} />
                ))}
              </div>
              <div className="chart-axis" aria-hidden="true">
                {summary.daily.map((point, index) => (
                  <span key={point.day}>{ticks.includes(index) ? point.day.slice(5) : ''}</span>
                ))}
              </div>
            </div>

            {summary.models.length ? (
              <div className="data-table-wrap">
                <table className="data-table" aria-label="按模型统计">
                  <thead>
                    <tr>
                      <th scope="col">模型</th>
                      <th scope="col" className="cell-right">
                        请求次数
                      </th>
                      <th scope="col" className="cell-right">
                        输入 Tokens
                      </th>
                      <th scope="col" className="cell-right">
                        输出 Tokens
                      </th>
                      <th scope="col" className="cell-right">
                        合计
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.models.map((stat) => (
                      <tr key={stat.model}>
                        <td className="cell-strong">{stat.model}</td>
                        <td className="cell-number cell-right">{count(stat.requests)}</td>
                        <td className="cell-number cell-right">{count(stat.promptTokens)}</td>
                        <td className="cell-number cell-right">{count(stat.completionTokens)}</td>
                        <td className="cell-number cell-right">{count(stat.tokens)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-page">
                这个区间还没有请求　去对话里发一条消息，用量就会出现在这里
              </div>
            )}

            <p className="hint" style={{ marginTop: 14 }}>
              统计范围是<b>本机这个应用</b>发出的请求（读的是本地消息元数据，不联网、不上传）。
              与账号后台的账单口径不同：后台还含其它客户端的调用与赠金抵扣。
            </p>
          </>
        ) : null}
      </div>
    </div>
  );
}

/** 一根柱子：高度按峰值归一化，值为 0 时退化成一条浅色底线。 */
function Bar({ point, peak }: { point: UsageDailyPoint; peak: number }): JSX.Element {
  const ratio = peak > 0 ? point.tokens / peak : 0;
  return (
    <div
      className={point.tokens > 0 ? 'chart-bar' : 'chart-bar empty'}
      style={{ height: `${Math.max(ratio * 100, 1)}%` }}
      title={`${point.day}　${count(point.tokens)} tokens　${count(point.requests)} 次请求`}
    />
  );
}
