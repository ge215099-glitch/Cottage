/** 模型连接：紧凑列表与独立编辑弹窗。列表不展示配置详情或密钥占位。 */
import { useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { Provider, ProviderTestResult } from '@shared/types.js';
import { Icons } from './Icons.js';
import { ScrimDialog } from './Overlays.js';

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
    <div className="page provider-page">
      <div className="page-inner">
        <div className="page-head-row">
          <h1>模型连接</h1>
          <div className="page-head-actions">
            <button
              type="button"
              className="btn"
              disabled={!providers.length}
              onClick={() => {
                if (providers[0]) onViewUsage(providers[0]);
              }}
            >
              查看用量
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
          <ul className="provider-list" aria-label="模型连接列表">
            {providers.map(provider => {
              const result = testResults[provider.id];
              const testing = busyId === provider.id;
              return <li className="provider-row" key={provider.id}>
                <div className="provider-identity">
                  <b className="provider-name" title={provider.name}>{provider.name}</b>
                  <div className="provider-status" aria-live="polite">
                    {testing ? <span>正在测试…</span>
                      : result ? <span className={`connection-result ${result.outcome === 'ok' ? 'success' : 'failure'}`} role="status">
                        {result.outcome === 'ok' ? <><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>测试通过</>
                          : result.outcome === 'auth-failed' ? '鉴权失败' : '连接失败'}
                      </span>
                      : <span>{!provider.hasKey ? '未配置密钥' : provider.enabled ? '已启用' : '已停用'}</span>}
                    {result && !testing && !provider.enabled && <span>已停用</span>}
                  </div>
                </div>
                <div className="provider-actions">
                  <button type="button" className="btn" disabled={!provider.hasKey || testing} onClick={() => void onTest(provider.id)}>{testing ? '测试中…' : '测试'}</button>
                  <button type="button" className="icon-btn" title="编辑" aria-label={`编辑 ${provider.name}`} onClick={() => openEdit(provider)}>{Icons.edit()}</button>
                  <button type="button" className="icon-btn danger" title="删除" aria-label={`删除 ${provider.name}`} onClick={() => onDelete(provider)}>{Icons.trash()}</button>
                </div>
              </li>;
            })}
          </ul>
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
