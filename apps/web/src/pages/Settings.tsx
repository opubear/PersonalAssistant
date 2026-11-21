import { useEffect, useState, type FormEvent } from 'react';
import {
  Copy,
  Download,
  Search,
  Check,
  Monitor,
  ShieldCheck,
  Cpu,
  Wifi,
  Trash2,
  LockKeyhole,
  ArrowRight,
  FileJson,
  RefreshCw,
} from 'lucide-react';
import type { ContextResult, ProfileInput } from '@qiyi/contracts';
import { useAssistant } from '../state.js';
import { client, download, formatTime, syncLocal } from '../api.js';
import { Empty, PageTitle, StatusBadge } from '../components.js';

export function ContextPage() {
  const { snapshot, notify } = useAssistant();
  const [query, setQuery] = useState('');
  const [context, setContext] = useState<ContextResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const generate = async (search: string) => {
    setLoading(true);
    try {
      setContext(await client.call('context.get', { query: search, limit: 50 }));
    } catch (error) {
      notify(String(error), true);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void generate('');
  }, []);
  return (
    <>
      <PageTitle
        eyebrow="TAKE YOUR MEMORY WITH YOU"
        title="让新的对话，也熟悉你。"
        description="把已确认的个人资料整理成上下文，带给你喜欢的 AI 工具。"
        actions={
          <button
            className="button secondary"
            disabled={!context}
            onClick={() =>
              context && download('personal-context.md', context.markdown, 'text/markdown')
            }
          >
            <Download size={16} /> 导出 Markdown
          </button>
        }
      />
      <div className="context-layout">
        <section className="panel context-panel">
          <div className="section-heading">
            <h2>个人上下文</h2>
            <span className="badge status-confirmed">
              <span />
              {context?.memories.length ?? 0} 条已确认记忆
            </span>
          </div>
          <form
            className="context-search"
            onSubmit={(event) => {
              event.preventDefault();
              void generate(query);
            }}
          >
            <div className="search">
              <Search size={16} />
              <input
                placeholder="按场景筛选，例如：写作、工作…"
                aria-label="上下文关键词"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            <button className="button secondary small-button" disabled={loading}>
              生成 <ArrowRight size={14} />
            </button>
          </form>
          <textarea
            className="context-output"
            aria-label="生成的个人上下文"
            readOnly
            value={context?.markdown ?? '正在生成…'}
          />
          <div className="context-bottom">
            <span>
              <LockKeyhole size={13} /> 未确认与依据失效的资料不会出现
            </span>
            <button
              className="button primary"
              disabled={!context}
              onClick={async () => {
                if (!context) return;
                try {
                  await navigator.clipboard.writeText(context.markdown);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch {
                  notify('无法访问剪贴板，请选择文本复制或导出文件', true);
                }
              }}
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? '已复制' : '复制上下文'}
            </button>
          </div>
        </section>
        <aside>
          <div className="panel context-guide">
            <span className="guide-number">01</span>
            <h3>确认真实的自己</h3>
            <p>先在「我的资料」中核对信息。只有你认可的记忆才会用于个性化。</p>
            <span className="guide-number">02</span>
            <h3>带入下一次对话</h3>
            <p>复制左侧内容，粘贴到新对话的背景说明中。</p>
            <span className="guide-number">03</span>
            <h3>让工具共享记忆</h3>
            <p>适配器可调用 context.get 接口按关键词获取资料；也可通过「自动行动」保存到本机。</p>
          </div>
          <p className="context-count">
            你的空间目前有{' '}
            <strong>
              {
                snapshot.memories.filter(
                  (memory) => memory.status === 'confirmed' && !memory.evidenceStale,
                ).length
              }
            </strong>{' '}
            条可用记忆。
          </p>
        </aside>
      </div>
    </>
  );
}

export function Settings() {
  const { snapshot, local, mutate, busy, confirm } = useAssistant();
  const { profile } = snapshot;
  const [form, setForm] = useState<ProfileInput>({
    name: profile.name,
    bio: profile.bio,
    locale: profile.locale,
    timezone: profile.timezone,
  });
  const [revision, setRevision] = useState(profile.revision);
  const saveProfile = async (event: FormEvent) => {
    event.preventDefault();
    await mutate(async () => {
      const saved = await client.call('profile.update', { ...form, revision });
      setRevision(saved.revision);
    }, '个人信息已保存');
  };
  return (
    <>
      <PageTitle
        eyebrow="MAKE IT YOURS"
        title="你的空间，你的规则。"
        description="管理个人信息、连接状态和数据。"
      />
      <div className="settings-grid">
        <section className="panel settings-panel">
          <div className="section-heading">
            <h2>个人信息</h2>
            <span className="subtle-chip">手动维护</span>
          </div>
          <form className="editor-form" onSubmit={(event) => void saveProfile(event)}>
            <label>
              如何称呼你
              <input
                required
                maxLength={80}
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
              />
            </label>
            <label>
              关于自己
              <textarea
                rows={4}
                maxLength={2000}
                value={form.bio}
                onChange={(event) => setForm({ ...form, bio: event.target.value })}
                placeholder="当前关注什么，正在做什么…"
              />
            </label>
            <div className="form-row">
              <label>
                语言
                <input
                  required
                  value={form.locale}
                  onChange={(event) => setForm({ ...form, locale: event.target.value })}
                />
              </label>
              <label>
                时区
                <input
                  required
                  value={form.timezone}
                  onChange={(event) => setForm({ ...form, timezone: event.target.value })}
                  placeholder="Asia/Shanghai"
                />
              </label>
            </div>
            <div className="form-actions">
              <button className="button primary" disabled={busy}>
                保存个人信息
              </button>
            </div>
          </form>
        </section>
        <section className="panel settings-panel">
          <div className="section-heading">
            <h2>连接与分析</h2>
            <ShieldCheck size={19} />
          </div>
          <div className="setting-row">
            <Wifi size={20} />
            <div>
              <strong>服务器通信</strong>
              <p>{local?.transport === 'ssh' ? '通过 SSH 命令网关连接' : '本机 HTTP 开发连接'}</p>
            </div>
            <span className="badge status-confirmed">
              <span /> 已连接
            </span>
          </div>
          <div className="setting-row">
            <Cpu size={20} />
            <div>
              <strong>AI 分析模型</strong>
              <p>{snapshot.system.model ?? '尚未配置模型'}</p>
            </div>
            <span
              className={`badge ${snapshot.system.aiConfigured ? 'status-confirmed' : 'status-pending'}`}
            >
              {snapshot.system.aiConfigured ? '已配置' : '待连接'}
            </span>
          </div>
          {!snapshot.system.aiConfigured && (
            <div className="notice">
              在服务器 .env 中填写 MODEL_BASE_URL、MODEL_NAME 和可选的
              MODEL_API_KEY，再重启后端。也可连接本地模型的兼容接口。
            </div>
          )}
          <div className="setting-row">
            <Monitor size={20} />
            <div>
              <strong>本机适配服务</strong>
              <p>
                {local?.deviceId ?? '未连接'} ·{' '}
                {local?.lastSyncAt ? formatTime(local.lastSyncAt) : '尚未同步'}
              </p>
            </div>
            <button
              className="icon-button"
              aria-label="同步适配器"
              disabled={busy}
              onClick={() => void mutate(syncLocal, '本机同步完成')}
            >
              <RefreshCw size={16} />
            </button>
          </div>
          <p className="small muted">
            SSH 与模型密钥保留在配置端，不进入浏览器。采集目录与固定工具命令在本机
            adapter.config.json 中维护。
          </p>
        </section>
      </div>
      <section className="panel data-panel">
        <div className="data-panel-copy">
          <span className="tool-icon">
            <FileJson size={23} />
          </span>
          <div>
            <h2>你的数据，随时带走</h2>
            <p>导出个人资料、来源、原始记录、设备与任务记录。完整数据库备份请按部署文档操作。</p>
          </div>
        </div>
        <button
          className="button secondary"
          disabled={busy}
          onClick={() =>
            void mutate(async () => {
              const data = await client.call('data.export', {});
              download('qiyi-personal-data.json', JSON.stringify(data, null, 2));
            }, '数据已导出')
          }
        >
          <Download size={16} /> 导出全部信息
        </button>
      </section>
      <div className="settings-grid">
        <section className="panel settings-panel">
          <div className="section-heading">
            <h2>已注册设备</h2>
            <span className="muted small">{snapshot.devices.length} 个设备</span>
          </div>
          {snapshot.devices.length ? (
            snapshot.devices.map((device) => (
              <div className="device-row" key={device.id}>
                <Monitor size={20} />
                <div>
                  <strong>{device.name}</strong>
                  <code>{device.id}</code>
                  <small>
                    最后连接 {formatTime(device.lastSeenAt)} · {device.tools.length} 个工具
                  </small>
                </div>
                <button
                  className="icon-button danger-text"
                  aria-label={`移除设备 ${device.id}`}
                  onClick={() =>
                    confirm(
                      '移除设备记录？',
                      '请先停止该设备上的后台服务，否则它会在下次连接时重新注册。未完成任务会阻止移除。',
                      () => client.call('devices.delete', { id: device.id }),
                    )
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))
          ) : (
            <p className="muted">暂无设备。</p>
          )}
        </section>
        <section className="panel settings-panel">
          <div className="section-heading">
            <h2>分析记录</h2>
            <span className="muted small">最近 30 次</span>
          </div>
          {snapshot.analysisRuns.length ? (
            snapshot.analysisRuns.map((run) => (
              <div className="analysis-row" key={run.id}>
                <div>
                  <StatusBadge status={run.status} />
                  <strong>
                    {run.count} 条输入 · {run.proposed} 条提取
                  </strong>
                  <small>{formatTime(run.createdAt)}</small>
                  {run.error && <p className="error-text">{run.error}</p>}
                </div>
                <button
                  className="icon-button danger-text"
                  disabled={run.status === 'running'}
                  aria-label={`删除分析记录 ${run.id}`}
                  onClick={() =>
                    confirm(
                      '删除分析记录？',
                      '仅删除本次分析的运行记录，原始信息和个人资料会保留。',
                      () => client.call('analysis.delete', { id: run.id }),
                    )
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))
          ) : (
            <Empty
              title="还没有分析记录"
              description="连接模型并分析原始信息后，这里会显示结果。"
            />
          )}
        </section>
      </div>
    </>
  );
}
