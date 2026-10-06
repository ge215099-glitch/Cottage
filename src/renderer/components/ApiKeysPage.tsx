/**
 * API Key 模块（导航项「API Key」）。
 *
 * 形态参考 DeepSeek 开放平台的「API keys」页：**列表 + 弹窗**。
 *
 * 三条刻意的设计：
 *
 * 1. **页面上不常驻表单**。添加/编辑一律进弹窗，列表才是这一页的主角；
 *    常驻表单会让"我已经配过哪几把 Key"淹没在一堆输入框里。
 * 2. **密钥列显示的是掩码，不是密钥本身**。renderer 从主进程只能拿到
 *    `hasKey: boolean`（技术方案 6.4 规则 1），掩码是固定长度的占位符，
 *    不含真 Key 的任何片段——所以它不可能泄露，也不可能被误当成真值复制出去。
 * 3. **删除走全局确认框**。它是破坏性操作，且会牵连绑定了这个 Provider 的会话
 *    （外键 `ON DELETE SET NULL`），所以确认文案必须说清这一点。
 */
import { useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { Provider, ProviderTestResult } from '@shared/types.js';
import { Icons } from './Icons.js';
import { ScrimDialog } from './Overlays.js';

/** 密钥列的固定掩码：长度固定、不含真值，纯粹表达"这里有一把 Key"。 */
export const KEY_MASK = 'sk-••••••••••••••••';

export interface ApiKeysPageProps {
  providers: Provider[];
  busyId: string | null;
  testResults: Record<string, ProviderTestResult>;
  onTest(id: string): Promise<void>;
  onSave(input: {
    id?: string;
    name: string;
    type: 'openai' | 'anthropic';
    baseUrl: string;
    apiKey?: string;
    clearKey?: boolean;
    models: string[];
    defaultModel: string;
    compressionModel: string;
    enabled: boolean;
  }): Promise<string | null>;
  onDelete(provider: Provider): void;
  /** 跳到用量页并只看这一把 Key */
  onViewUsage(provider: Provider): void;
}

interface FormState {
  name: string;
  type: 'openai' | 'anthropic';
  baseUrl: string;
  apiKey: string;
  models: string;
  defaultModel: string;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  name: '',
  type: 'openai',
  baseUrl: '',
  apiKey: '',
  models: '',
  defaultModel: '',
  enabled: true,
};

function formFromProvider(provider: Provider): FormState {
  return {
    name: provider.name,
    type: provider.type,
    baseUrl: provider.baseUrl,
    // 密钥永不回填（renderer 也拿不到它）；留空即"不改动已保存的 Key"
    apiKey: '',
    models: provider.models.join(', '),
    defaultModel: provider.defaultModel,
    enabled: provider.enabled,
  };
}

/** 日期列：只到天，空值显示「—」。 */
export function formatDay(ms: number | null): string {
  if (ms === null) return '—';
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function ApiKeysPage({
  providers,
  busyId,
  testResults,
  onTest,
  onSave,
  onDelete,
  onViewUsage,
}: ApiKeysPageProps): JSX.Element {
  /** null = 弹窗关闭；`'new'` = 新建；其余是正在编辑的 provider id */
  const [editing, setEditing] = useState<'new' | string | null>(null);
  const [form, setForm] = useState<FormState>({ ...EMPTY_FORM });
  const [formError, setFormError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const firstFieldRef = useRef<HTMLInputElement | null>(null);

  const editingProvider = useMemo(
    () => (editing && editing !== 'new' ? (providers.find((p) => p.id === editing) ?? null) : null),
    [editing, providers],
  );

  const openNew = (): void => {
    setForm({ ...EMPTY_FORM });
    setFormError(null);
    setEditing('new');
  };

  const openEdit = (provider: Provider): void => {
    setForm(formFromProvider(provider));
    setFormError(null);
    setEditing(provider.id);
  };

  const close = (): void => {
    if (saving) return;
    setEditing(null);
    setFormError(null);
  };

  const submit = async (): Promise<void> => {
    if (!form.name.trim() || !form.baseUrl.trim()) return;
    setSaving(true);
    setFormError(null);
    const error = await onSave({
      ...(editingProvider ? { id: editingProvider.id } : {}),
      name: form.name.trim(),
      type: form.type,
      baseUrl: form.baseUrl.trim(),
      ...(form.apiKey ? { apiKey: form.apiKey } : {}),
      models: form.models
        .split(/[,，]/)
        .map((m) => m.trim())
        .filter(Boolean),
      defaultModel: form.defaultModel.trim(),
      compressionModel: form.defaultModel.trim(),
      enabled: form.enabled,
    });
    setSaving(false);
    // 失败就留在弹窗里报错：把用户刚填的一屏内容丢掉是最差的做法
    if (error) setFormError(error);
    else setEditing(null);
  };

  return (
    <div className="page">
      <div className="page-inner">
        <div className="page-head-row">
          <h1>API Key</h1>
          <div className="page-head-actions">
            <button
              type="button"
              className="btn"
              disabled={!providers.length}
              onClick={() => {
                if (providers[0]) onViewUsage(providers[0]);
              }}
            >
              按 API Key 查看用量
            </button>
            <button type="button" className="btn primary" style={{ width: 'auto' }} onClick={openNew}>
              创建 API Key
            </button>
          </div>
        </div>

        {providers.length === 0 ? (
          <div className="empty-page">
            还没有 API Key　点击「创建 API Key」添加第一个
          </div>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table" aria-label="API Key 列表">
              <thead>
                <tr>
                  <th scope="col">名称</th>
                  <th scope="col">状态</th>
                  <th scope="col">Key</th>
                  <th scope="col">创建日期</th>
                  <th scope="col">最新使用日期</th>
                  <th scope="col" className="col-actions">
                    <span className="sr-only">操作</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {providers.map((provider) => {
                  const result = testResults[provider.id];
                  const testing = busyId === provider.id;
                  return (
                    <tr key={provider.id}>
                      <td>
                        <div className="cell-strong">{provider.name}</div>
                        <div className="cell-sub">
                          {provider.type === 'anthropic' ? 'Anthropic' : 'OpenAI 兼容'} ·{' '}
                          {provider.baseUrl}
                        </div>
                        <div className="cell-sub">
                          {provider.defaultModel
                            ? `默认模型 ${provider.defaultModel}`
                            : '未设置默认模型'}
                          {provider.models.length ? ` · 共 ${provider.models.length} 个模型` : ''}
                        </div>
                        {result ? (
                          <div
                            className={
                              result.outcome === 'ok'
                                ? 'test-result ok'
                                : result.outcome === 'auth-failed'
                                  ? 'test-result warn'
                                  : 'test-result fail'
                            }
                          >
                            {result.outcome === 'ok'
                              ? '可达，鉴权通过'
                              : result.outcome === 'auth-failed'
                                ? '可达，鉴权失败'
                                : '不可达'}
                            {result.httpStatus ? `（HTTP ${result.httpStatus}）` : ''}
                            {' · '}
                            {result.message}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <span className={provider.enabled ? 'tag ok' : 'tag'}>
                          {provider.enabled ? '已启用' : '已停用'}
                        </span>
                      </td>
                      <td>
                        {provider.hasKey ? (
                          <code className="key-mask">{KEY_MASK}</code>
                        ) : (
                          <span className="key-status warn">未配置 Key</span>
                        )}
                      </td>
                      <td className="cell-mono">{formatDay(provider.createdAt)}</td>
                      <td className="cell-mono">{formatDay(provider.lastUsedAt)}</td>
                      <td className="col-actions">
                        <div className="row-actions">
                          <button
                            type="button"
                            className="btn"
                            disabled={!provider.hasKey || testing}
                            onClick={() => void onTest(provider.id)}
                          >
                            {testing ? '测试中…' : '测试'}
                          </button>
                          <button
                            type="button"
                            className="icon-btn"
                            title="编辑"
                            aria-label={`编辑 ${provider.name}`}
                            onClick={() => openEdit(provider)}
                          >
                            {Icons.edit()}
                          </button>
                          <button
                            type="button"
                            className="icon-btn danger"
                            title="删除"
                            aria-label={`删除 ${provider.name}`}
                            onClick={() => onDelete(provider)}
                          >
                            {Icons.trash()}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing ? (
        <ScrimDialog
          title={editingProvider ? `编辑 API Key：${editingProvider.name}` : '创建 API Key'}
          className="form-dialog"
          initialFocusRef={firstFieldRef}
          onClose={close}
          footer={
            <>
              {editingProvider ? (
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => {
                    close();
                    onDelete(editingProvider);
                  }}
                >
                  删除
                </button>
              ) : null}
              <div className="spacer" />
              <button type="button" className="btn" disabled={saving} onClick={close}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                style={{ width: 'auto' }}
                disabled={saving || !form.name.trim() || !form.baseUrl.trim()}
                onClick={() => void submit()}
              >
                {editingProvider ? '保存修改' : '创建'}
              </button>
            </>
          }
        >
          <div className="provider-form">
            <div className="field">
              <label htmlFor="k-name">名称</label>
              <input
                ref={firstFieldRef}
                id="k-name"
                type="text"
                value={form.name}
                placeholder="例如：本地 DeepSeek"
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="k-type">类型</label>
              <select
                id="k-type"
                value={form.type}
                onChange={(event) =>
                  setForm({ ...form, type: event.target.value as 'openai' | 'anthropic' })
                }
              >
                <option value="openai">OpenAI 兼容</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="k-url">base_url</label>
              <input
                id="k-url"
                type="text"
                value={form.baseUrl}
                placeholder="https://api.example.com/v1"
                onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="k-key">
                API Key{editingProvider ? '（留空表示不修改已保存的 Key）' : ''}
              </label>
              <input
                id="k-key"
                type="password"
                value={form.apiKey}
                autoComplete="off"
                onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="k-models">模型列表（逗号分隔）</label>
              <input
                id="k-models"
                type="text"
                value={form.models}
                placeholder="deepseek-chat, deepseek-reasoner"
                onChange={(event) => setForm({ ...form, models: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="k-default">默认模型</label>
              <input
                id="k-default"
                type="text"
                value={form.defaultModel}
                placeholder="deepseek-chat"
                onChange={(event) => setForm({ ...form, defaultModel: event.target.value })}
              />
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={form.enabled}
                onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
              />
              启用这一把 Key
            </label>
          </div>
          {formError ? (
            <div className="dialog-error" role="alert">
              {formError}
            </div>
          ) : null}
        </ScrimDialog>
      ) : null}
    </div>
  );
}
