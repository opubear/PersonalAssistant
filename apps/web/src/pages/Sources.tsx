import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  Plus,
  Upload,
  FileText,
  Terminal,
  AppWindow,
  Pencil,
  Trash2,
  Pause,
  Play,
  Sparkles,
  ArrowRight,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  Waypoints,
} from 'lucide-react';
import {
  type Source,
  type SourceInput,
  type Observation,
  type ObservationInput,
} from '@qiyi/contracts';
import {
  parseImport,
  defaultImportRegistry,
  uploadObservations,
  type ParseResult,
} from '@qiyi/adapters';
import { client, formatTime, syncLocal } from '../api.js';
import { useAssistant } from '../state.js';
import { Empty, Modal, PageTitle } from '../components.js';

const sourceKinds: Record<string, string> = Object.fromEntries([
  ...defaultImportRegistry.list().map(({ id, title }) => [id, title]),
  ['manual', '手动记录'],
]);
const sourceIcons: Record<string, typeof Terminal> = {
  codex: Terminal,
  'chat-jsonl': FileText,
  'app-jsonl': AppWindow,
  manual: Pencil,
};
const sourceInput = (source: Source): SourceInput => ({
  name: source.name,
  kind: source.kind,
  enabled: source.enabled,
  autoAnalyze: source.autoAnalyze,
});

export function Sources() {
  const { snapshot, local, mutate, busy, confirm, notify } = useAssistant();
  const [sourceEditor, setSourceEditor] = useState<Source | 'new' | null>(null);
  const [importSource, setImportSource] = useState<Source | null>(null);
  const [observationEditor, setObservationEditor] = useState<Observation | 'new' | null>(null);
  const [offset, setOffset] = useState(0);
  const [records, setRecords] = useState<{ items: Observation[]; total: number }>({
    items: snapshot.observations,
    total: snapshot.observationCount,
  });
  useEffect(() => {
    let active = true;
    void client
      .call('observations.list', { offset, limit: 20 })
      .then((value) => {
        if (active) setRecords(value);
      })
      .catch((error) => {
        if (active) notify(String(error), true);
      });
    return () => {
      active = false;
    };
  }, [offset, snapshot]);
  return (
    <>
      <PageTitle
        eyebrow="CONNECTED TO YOUR EVERYDAY"
        title="从日常里，收集线索。"
        description="连接对话与应用记录，保留每条记忆的来处。"
        actions={
          <>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() => void mutate(syncLocal, '本机同步完成')}
            >
              <RefreshCw size={16} /> 同步本机
            </button>
            <button className="button primary" onClick={() => setSourceEditor('new')}>
              <Plus size={17} /> 添加来源
            </button>
          </>
        }
      />
      {local?.lastError && <div className="notice warning">本机采集：{local.lastError}</div>}
      {!!local?.reportConflicts?.length && (
        <div className="notice warning" role="status">
          有 {local.reportConflicts.length}{' '}
          个行动结果未被服务器接受，同步已恢复。请核对行动记录与本机输出目录中的 report-conflicts
          记录。
        </div>
      )}
      <div className="source-grid">
        {snapshot.sources.map((source) => {
          const Icon = sourceIcons[source.kind] ?? Waypoints;
          const attached = local?.collectors.some((collector) => collector.sourceId === source.id);
          return (
            <article className="panel source-card" key={source.id}>
              <div className="source-top">
                <span className={`source-icon ${source.kind}`}>
                  <Icon size={23} />
                </span>
                <span
                  className={`badge ${source.enabled ? 'status-confirmed' : 'status-cancelled'}`}
                >
                  <span />
                  {source.enabled ? '已启用' : '已暂停'}
                </span>
              </div>
              <h3>{source.name}</h3>
              <p>{sourceKinds[source.kind] ?? source.kind}</p>
              <dl>
                <div>
                  <dt>来源 ID</dt>
                  <dd>
                    <code>{source.id}</code>
                  </dd>
                </div>
                <div>
                  <dt>AI 分析</dt>
                  <dd>{source.autoAnalyze ? '上传后自动提取' : '手动触发'}</dd>
                </div>
                <div>
                  <dt>本机采集</dt>
                  <dd>{attached ? '已连接采集器' : '未连接采集器'}</dd>
                </div>
              </dl>
              <div className="source-footer">
                <button
                  className="text-button"
                  disabled={
                    !source.enabled ||
                    (source.kind !== 'manual' && !defaultImportRegistry.has(source.kind))
                  }
                  onClick={() =>
                    source.kind === 'manual' ? setObservationEditor('new') : setImportSource(source)
                  }
                >
                  <Upload size={15} />
                  {source.kind === 'manual'
                    ? '添加记录'
                    : defaultImportRegistry.has(source.kind)
                      ? '导入文件'
                      : '由适配器上传'}
                </button>
                <div className="card-tools">
                  <button
                    className="icon-button"
                    title={source.enabled ? '暂停采集' : '恢复采集'}
                    aria-label={`${source.enabled ? '暂停' : '启用'} ${source.name}`}
                    disabled={busy}
                    onClick={() =>
                      void mutate(
                        () =>
                          client.call('sources.update', {
                            ...sourceInput(source),
                            id: source.id,
                            revision: source.revision,
                            enabled: !source.enabled,
                          }),
                        source.enabled ? '来源已暂停' : '来源已启用',
                      )
                    }
                  >
                    {source.enabled ? <Pause size={15} /> : <Play size={15} />}
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`编辑来源 ${source.name}`}
                    onClick={() => setSourceEditor(source)}
                  >
                    <Pencil size={15} />
                  </button>
                  <button
                    className="icon-button danger-text"
                    aria-label={`删除来源 ${source.name}`}
                    onClick={() =>
                      confirm(
                        '删除此来源及其原始记录？',
                        '关联的个人资料会标记为需要重新核对，原始记录将被删除且不会因再次同步自动恢复。',
                        () =>
                          client.call('sources.delete', {
                            id: source.id,
                            revision: source.revision,
                          }),
                      )
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            </article>
          );
        })}
        <button className="add-source-card" onClick={() => setSourceEditor('new')}>
          <span>
            <Plus size={25} strokeWidth={1.4} />
          </span>
          <strong>连接新的日常</strong>
          <small>对话、使用记录，或一条手记</small>
        </button>
      </div>
      <div className="section-heading records-heading">
        <h2>
          原始信息 <span>{records.total} 条记录</span>
        </h2>
        <div className="page-actions">
          <button
            className="button secondary small-button"
            disabled={!snapshot.sources.some((source) => source.enabled)}
            onClick={() => setObservationEditor('new')}
          >
            <Plus size={15} /> 手动添加
          </button>
          <button
            className="button primary small-button"
            disabled={busy || !snapshot.pendingAnalysis || !snapshot.system.aiConfigured}
            onClick={() =>
              void mutate(() => client.call('analysis.run', {}), '分析完成，候选资料已生成')
            }
          >
            <Sparkles size={15} /> {busy ? '处理中…' : `分析信息 (${snapshot.pendingAnalysis})`}
          </button>
        </div>
      </div>
      {snapshot.system.automaticAnalysisPause && (
        <div className="notice warning">
          自动分析已暂停：{snapshot.system.automaticAnalysisPause}
          。修复配置并手动分析成功后恢复，不会反复请求模型。
        </div>
      )}
      {!snapshot.system.aiConfigured && (
        <div className="notice">
          <Sparkles size={16} />
          <span>信息可正常上传和编辑。连接模型后，即可从中提取个人资料。</span>
        </div>
      )}
      <section className="panel records-panel">
        {records.items.length ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>内容与来源</th>
                    <th>类型</th>
                    <th>状态</th>
                    <th>发生时间</th>
                    <th>
                      <span className="sr-only">操作</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {records.items.map((record) => (
                    <tr key={record.id}>
                      <td>
                        <button
                          className="record-text"
                          onClick={() => setObservationEditor(record)}
                        >
                          {record.content}
                        </button>
                        <small className="record-source">
                          {snapshot.sources.find((source) => source.id === record.sourceId)?.name ??
                            record.sourceId}{' '}
                          ·{' '}
                          {record.role === 'user'
                            ? '用户'
                            : record.role === 'assistant'
                              ? '助手'
                              : '事件'}
                        </small>
                      </td>
                      <td>
                        <span className="subtle-chip">
                          {record.kind === 'chat'
                            ? '对话'
                            : record.kind === 'app'
                              ? '应用'
                              : '手记'}
                        </span>
                      </td>
                      <td>
                        <span
                          className={`record-state ${record.analyzedHash === record.contentHash ? 'done' : ''}`}
                        >
                          {record.edited
                            ? '手动修正'
                            : record.role === 'assistant'
                              ? '上下文参考'
                              : record.analyzedHash === record.contentHash
                                ? '已分析'
                                : '待分析'}
                        </span>
                      </td>
                      <td className="nowrap">{formatTime(record.occurredAt)}</td>
                      <td>
                        <div className="card-tools">
                          <button
                            className="icon-button"
                            aria-label={`编辑记录 ${record.externalId}`}
                            onClick={() => setObservationEditor(record)}
                          >
                            <Pencil size={15} />
                          </button>
                          <button
                            className="icon-button danger-text"
                            aria-label={`删除记录 ${record.externalId}`}
                            onClick={() =>
                              confirm(
                                '删除这条原始记录？',
                                '关联资料会被标记为依据已变更，暂时不再用于个性化服务。',
                                () =>
                                  client.call('observations.delete', {
                                    id: record.id,
                                    revision: record.revision,
                                  }),
                              )
                            }
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span>
                {offset + 1}–{Math.min(offset + records.items.length, records.total)} /{' '}
                {records.total}
              </span>
              <button
                className="icon-button"
                aria-label="上一页"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - 20))}
              >
                <ChevronLeft size={17} />
              </button>
              <button
                className="icon-button"
                aria-label="下一页"
                disabled={offset + 20 >= records.total}
                onClick={() => setOffset(offset + 20)}
              >
                <ChevronRight size={17} />
              </button>
            </div>
          </>
        ) : (
          <Empty
            title="日常的小细节，会在这里汇集"
            description="先添加一个信息来源，再导入聊天文件或手动记录。"
          />
        )}
      </section>
      {sourceEditor && (
        <SourceEditor
          source={sourceEditor === 'new' ? undefined : sourceEditor}
          onClose={() => setSourceEditor(null)}
        />
      )}
      {importSource && <ImportDialog source={importSource} onClose={() => setImportSource(null)} />}
      {observationEditor && (
        <ObservationEditor
          observation={observationEditor === 'new' ? undefined : observationEditor}
          onClose={() => setObservationEditor(null)}
        />
      )}
    </>
  );
}

function SourceEditor({ source, onClose }: { source?: Source; onClose: () => void }) {
  const { mutate, busy } = useAssistant();
  const [form, setForm] = useState<SourceInput>(
    source ? sourceInput(source) : { name: '', kind: 'codex', enabled: true, autoAnalyze: false },
  );
  const [id, setId] = useState(source?.id ?? `source-${crypto.randomUUID().slice(0, 8)}`);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (
      await mutate(
        () =>
          source
            ? client.call('sources.update', { ...form, id, revision: source.revision })
            : client.call('sources.create', { ...form, id }),
        '信息来源已保存',
      )
    )
      onClose();
  };
  return (
    <Modal
      title={source ? '编辑信息来源' : '添加一个信息来源'}
      description="选择数据格式，决定什么时候开始收集与分析。"
      onClose={onClose}
    >
      <form className="editor-form" onSubmit={(event) => void submit(event)}>
        <label>
          名称
          <input
            value={form.name}
            required
            maxLength={80}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="例如：我的 Codex 对话"
            autoFocus
          />
        </label>
        <div className="form-row">
          <label>
            格式
            <input
              list="source-formats"
              value={form.kind}
              required
              maxLength={80}
              onChange={(event) => setForm({ ...form, kind: event.target.value })}
            />
            <datalist id="source-formats">
              {Object.entries(sourceKinds).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </datalist>
            <small>可选择内置格式，或填写适配器提供的格式标识。</small>
          </label>
          <label>
            来源 ID
            <input
              required
              disabled={!!source}
              maxLength={160}
              value={id}
              onChange={(event) => setId(event.target.value)}
            />
          </label>
        </div>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(event) => setForm({ ...form, enabled: event.target.checked })}
          />
          <span>
            启用此来源<small>暂停后不再接受新数据或参与分析。</small>
          </span>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={form.autoAnalyze}
            onChange={(event) => setForm({ ...form, autoAnalyze: event.target.checked })}
          />
          <span>
            上传后自动分析<small>允许服务器把该来源的待分析信息发送到你配置的模型。</small>
          </span>
        </label>
        <div className="notice">
          <Waypoints size={16} />
          <span>后台采集目录在本机 adapter.config.json 配置。仅添加来源不会读取本机文件。</span>
        </div>
        <div className="form-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            保存来源
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ImportDialog({ source, onClose }: { source: Source; onClose: () => void }) {
  const { mutate, busy, notify } = useAssistant();
  const [preview, setPreview] = useState<ParseResult | null>(null);
  const [filename, setFilename] = useState('');
  const [error, setError] = useState('');
  const selectionSequence = useRef(0);
  const choose = async (file?: File) => {
    if (!file) return;
    const sequence = ++selectionSequence.current;
    setPreview(null);
    setError('');
    setFilename(file.name);
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('文件超过 20 MiB，请拆分后导入');
      const result = parseImport(source.kind, await file.text(), file.name.replace(/\.jsonl$/, ''));
      if (sequence !== selectionSequence.current) return;
      if (!result.observations.length) throw new Error('没有找到可导入的消息，请检查格式');
      setPreview(result);
    } catch (error) {
      if (sequence !== selectionSequence.current) return;
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  return (
    <Modal
      title={`导入到「${source.name}」`}
      description="先在本机预览，再由你决定上传。"
      onClose={onClose}
      wide
    >
      <div className="editor-form">
        <label className="upload-zone">
          <Upload size={26} />
          <strong>{filename || '选择一个 JSONL 文件'}</strong>
          <span>{sourceKinds[source.kind] ?? source.kind} · 最大 20 MiB</span>
          <input
            aria-label="选择导入文件"
            type="file"
            accept=".jsonl,.ndjson,.json"
            onChange={(event) => void choose(event.target.files?.[0])}
          />
        </label>
        {error && (
          <div className="notice warning" role="alert">
            {error}
          </div>
        )}
        {preview && (
          <>
            <div className="import-summary">
              <strong>{preview.observations.length} 条可导入信息</strong>
              <span>跳过 {preview.ignored} 条非消息记录</span>
            </div>
            <div className="import-preview">
              {preview.observations.slice(0, 5).map((record, index) => (
                <div key={index}>
                  <span className="subtle-chip">{record.role}</span>
                  <p>{record.content}</p>
                </div>
              ))}
            </div>
            <p className="small muted">
              预览前 5 条。上传会保存原始内容，重复记录自动跳过。
              {source.autoAnalyze ? '此来源已启用自动分析。' : '此来源需手动触发分析。'}
            </p>
          </>
        )}
        <div className="form-actions">
          <button className="button secondary" onClick={onClose}>
            取消
          </button>
          <button
            className="button primary"
            disabled={!preview || busy}
            onClick={async () => {
              if (!preview) return;
              let message = '';
              if (
                await mutate(async () => {
                  const result = await uploadObservations(client, source.id, preview.observations);
                  message = `已新增 ${result.created} 条，更新 ${result.updated} 条，跳过 ${result.skipped} 条`;
                }, '导入完成')
              ) {
                notify(message);
                onClose();
              }
            }}
          >
            {busy ? '正在上传…' : '确认上传'}
            <ArrowRight size={15} />
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ObservationEditor({
  observation,
  onClose,
}: {
  observation?: Observation;
  onClose: () => void;
}) {
  const { snapshot, mutate, busy, notify } = useAssistant();
  const [sourceId, setSourceId] = useState(
    observation?.sourceId ?? snapshot.sources.find((source) => source.enabled)?.id ?? '',
  );
  const [form, setForm] = useState<ObservationInput>(
    observation
      ? {
          externalId: observation.externalId,
          kind: observation.kind,
          role: observation.role,
          content: observation.content,
          occurredAt: observation.occurredAt,
          metadata: observation.metadata,
        }
      : {
          externalId: crypto.randomUUID(),
          kind: 'note',
          role: 'user',
          content: '',
          occurredAt: new Date().toISOString(),
          metadata: {},
        },
  );
  const [metadata, setMetadata] = useState(JSON.stringify(form.metadata, null, 2));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    let parsed: ObservationInput['metadata'];
    try {
      parsed = JSON.parse(metadata);
    } catch {
      notify('元数据必须是有效的 JSON 对象', true);
      return;
    }
    const { externalId, ...content } = { ...form, metadata: parsed };
    if (
      await mutate(
        () =>
          observation
            ? client.call('observations.update', {
                ...content,
                id: observation.id,
                revision: observation.revision,
              })
            : client.call('observations.import', {
                sourceId,
                observations: [{ ...content, externalId }],
              }),
        '原始记录已保存',
      )
    )
      onClose();
  };
  return (
    <Modal
      title={observation ? '编辑原始记录' : '添加一条手记'}
      description={
        observation ? '手工修正会保留，之后的同步不会覆盖它。' : '记下一个需求、想法或日常观察。'
      }
      onClose={onClose}
      wide
    >
      <form className="editor-form" onSubmit={(event) => void submit(event)}>
        <label>
          信息来源
          <select
            value={sourceId}
            disabled={!!observation}
            onChange={(event) => setSourceId(event.target.value)}
          >
            {snapshot.sources
              .filter((source) => source.enabled || source.id === sourceId)
              .map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
          </select>
        </label>
        <div className="form-row">
          <label>
            类型
            <select
              value={form.kind}
              onChange={(event) =>
                setForm({ ...form, kind: event.target.value as ObservationInput['kind'] })
              }
            >
              <option value="chat">聊天</option>
              <option value="app">应用事件</option>
              <option value="note">手记</option>
            </select>
          </label>
          <label>
            发言角色
            <select
              value={form.role}
              onChange={(event) =>
                setForm({ ...form, role: event.target.value as ObservationInput['role'] })
              }
            >
              <option value="user">用户</option>
              <option value="assistant">助手</option>
              <option value="event">事件</option>
            </select>
          </label>
        </div>
        <label>
          内容
          <textarea
            required
            maxLength={20000}
            rows={7}
            value={form.content}
            onChange={(event) => setForm({ ...form, content: event.target.value })}
            autoFocus
          />
        </label>
        <label>
          发生时间（ISO 8601）
          <input
            required
            value={form.occurredAt}
            onChange={(event) => setForm({ ...form, occurredAt: event.target.value })}
          />
        </label>
        <details>
          <summary>编辑元数据</summary>
          <textarea
            className="code-input"
            aria-label="元数据 JSON"
            rows={4}
            value={metadata}
            onChange={(event) => setMetadata(event.target.value)}
          />
        </details>
        <div className="form-actions">
          <button className="button secondary" type="button" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy || !sourceId}>
            保存记录
          </button>
        </div>
      </form>
    </Modal>
  );
}
