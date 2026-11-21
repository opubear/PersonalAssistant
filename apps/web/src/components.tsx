import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { X, Feather, Pencil, Check, Trash2, ArrowUpRight, AlertCircle } from 'lucide-react';
import { categoryLabels, type Memory, type MemoryInput } from '@qiyi/contracts';
import { client, formatTime } from './api.js';
import { useAssistant } from './state.js';

export function Modal({
  title,
  description,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className={`modal ${wide ? 'wide' : ''}`}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === dialog.current) {
          const rect = dialog.current.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <div className="modal-header">
        <div>
          <h2>{title}</h2>
          {description && <p>{description}</p>}
        </div>
        <button className="icon-button" onClick={onClose} aria-label="关闭">
          <X size={20} />
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function Empty({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Feather size={28} strokeWidth={1.4} />
      </span>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}

export function PageTitle({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-title">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="page-actions">{actions}</div>
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const labels: Record<string, string> = {
    confirmed: '已确认',
    proposed: '待确认',
    rejected: '已忽略',
    pending: '待批准',
    approved: '等待执行',
    running: '执行中',
    succeeded: '已完成',
    failed: '失败',
    cancelled: '已取消',
  };
  return (
    <span className={`badge status-${status}`}>
      <span />
      {labels[status] ?? status}
    </span>
  );
}

export function memoryInput(memory: Memory): MemoryInput {
  return {
    title: memory.title,
    content: memory.content,
    category: memory.category,
    tags: memory.tags,
    confidence: memory.confidence,
    status: memory.status,
  };
}

const memoryOriginLabels: Record<Memory['origin'], string> = {
  manual: '由你维护',
  ai: 'AI 提取',
  agent: 'Agent 提议',
};

export function MemoryCard({
  memory,
  onEdit,
  compact = false,
}: {
  memory: Memory;
  onEdit: (memory: Memory) => void;
  compact?: boolean;
}) {
  const { mutate, confirm, busy } = useAssistant();
  return (
    <article className={`memory-card ${compact ? 'compact' : ''}`}>
      <div className="memory-card-top">
        <span className={`category category-${memory.category}`}>
          {categoryLabels[memory.category]}
        </span>
        <StatusBadge status={memory.status} />
      </div>
      <h3>{memory.title}</h3>
      <p className="memory-content">{memory.content}</p>
      {memory.evidenceStale && (
        <p className="stale">
          <AlertCircle size={13} /> 依据已变更，请重新核对
        </p>
      )}
      {memory.tags.length > 0 && !compact && (
        <div className="tags">
          {memory.tags.map((tag) => (
            <span key={tag}>#{tag}</span>
          ))}
        </div>
      )}
      <div className="memory-footer">
        <span>
          {memoryOriginLabels[memory.origin]} · {formatTime(memory.updatedAt)}
        </span>
        <div className="card-tools">
          {memory.status === 'proposed' && !memory.evidenceStale && (
            <button
              className="icon-button accept"
              title="确认这条资料"
              aria-label={`确认 ${memory.title}`}
              disabled={busy}
              onClick={() =>
                void mutate(
                  () =>
                    client.call('memories.update', {
                      ...memoryInput(memory),
                      id: memory.id,
                      revision: memory.revision,
                      status: 'confirmed',
                    }),
                  '已加入个人资料',
                )
              }
            >
              <Check size={17} />
            </button>
          )}
          <button
            className="icon-button"
            onClick={() => onEdit(memory)}
            title="编辑资料"
            aria-label={`编辑 ${memory.title}`}
          >
            <Pencil size={15} />
          </button>
          {!compact && (
            <button
              className="icon-button danger-text"
              aria-label={`删除 ${memory.title}`}
              onClick={() =>
                confirm('删除这条资料？', '这条资料将从个人上下文中移除，原始记录仍会保留。', () =>
                  client.call('memories.delete', { id: memory.id, revision: memory.revision }),
                )
              }
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

export function MemoryEditor({ memory, onClose }: { memory?: Memory; onClose: () => void }) {
  const { mutate, busy, snapshot } = useAssistant();
  const [form, setForm] = useState<MemoryInput>(
    memory
      ? memoryInput(memory)
      : {
          category: 'preference',
          title: '',
          content: '',
          tags: [],
          confidence: 1,
          status: 'confirmed',
        },
  );
  const [tags, setTags] = useState(form.tags.join(', '));
  const [evidence, setEvidence] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const input = {
      ...form,
      tags: [
        ...new Set(
          tags
            .split(/[,，]/)
            .map((tag) => tag.trim())
            .filter(Boolean),
        ),
      ],
    };
    const success = await mutate(
      () =>
        memory
          ? client.call('memories.update', { ...input, id: memory.id, revision: memory.revision })
          : client.call('memories.create', input),
      '资料已保存',
    );
    if (success) onClose();
  };
  return (
    <Modal
      title={memory ? '编辑个人资料' : '记下一条关于你的事'}
      description="你始终可以修正、确认或删除这些信息。"
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)} className="editor-form">
        <div className="form-row">
          <label>
            分类
            <select
              value={form.category}
              onChange={(event) =>
                setForm({ ...form, category: event.target.value as MemoryInput['category'] })
              }
            >
              {Object.entries(categoryLabels).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            状态
            <select
              value={form.status}
              onChange={(event) =>
                setForm({ ...form, status: event.target.value as MemoryInput['status'] })
              }
            >
              <option value="confirmed">已确认</option>
              <option value="proposed">待确认</option>
              <option value="rejected">已忽略</option>
            </select>
          </label>
        </div>
        <label>
          标题
          <input
            required
            maxLength={160}
            value={form.title}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
            placeholder="例如：喜欢先看到结论"
            autoFocus
          />
        </label>
        <label>
          具体说明
          <textarea
            required
            maxLength={4000}
            rows={4}
            value={form.content}
            onChange={(event) => setForm({ ...form, content: event.target.value })}
            placeholder="什么样的服务方式更适合你？"
          />
        </label>
        <label>
          标签<span className="field-hint">用逗号分隔，最多 12 个</span>
          <input
            value={tags}
            onChange={(event) => setTags(event.target.value)}
            placeholder="沟通, 工作"
          />
        </label>
        <label>
          确信程度 · {Math.round(form.confidence * 100)}%
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={form.confidence}
            onChange={(event) => setForm({ ...form, confidence: Number(event.target.value) })}
          />
        </label>
        {!!memory?.evidenceIds.length && (
          <div className="evidence">
            <h4>来源依据 · {memory.evidenceIds.length} 条</h4>
            {memory.evidenceIds.map((id) => {
              const item = snapshot.observations.find((observation) => observation.id === id);
              return (
                <button
                  type="button"
                  key={id}
                  onClick={async () => {
                    try {
                      const record = await client.call('observations.get', { id });
                      setEvidence(record.content);
                    } catch {
                      setEvidence('此条原始记录已删除。');
                    }
                  }}
                >
                  {item ? item.content.slice(0, 70) : `查看原始记录 ${id.slice(0, 8)}`}
                  <ArrowUpRight size={14} />
                </button>
              );
            })}
            {evidence && <pre>{evidence}</pre>}
          </div>
        )}
        {memory?.evidenceStale && (
          <div className="notice">依据已变更。保存表示你已重新核对本条资料。</div>
        )}
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            取消
          </button>
          <button className="button primary" disabled={busy}>
            {busy ? '保存中…' : '保存资料'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
