import { useState } from 'react';
import {
  ArrowRight,
  Plus,
  Sparkles,
  Fingerprint,
  Database,
  Waypoints,
  Search,
  Leaf,
  ArrowUpRight,
  CircleCheck,
  Clock3,
} from 'lucide-react';
import { categoryLabels, type Memory } from '@qiyi/contracts';
import { useAssistant } from '../state.js';
import { Empty, MemoryCard, MemoryEditor, PageTitle } from '../components.js';
import { client, formatTime } from '../api.js';

export function Overview() {
  const { snapshot, navigate, mutate, busy } = useAssistant();
  const [editor, setEditor] = useState<Memory | 'new' | null>(null);
  const confirmed = snapshot.memories.filter((memory) => memory.status === 'confirmed');
  const pending = snapshot.memories.filter((memory) => memory.status === 'proposed');
  const recent = snapshot.memories.filter((memory) => memory.status !== 'rejected').slice(0, 4);
  const stats = [
    {
      label: '已确认的记忆',
      value: confirmed.length,
      note: '逐渐清晰的你',
      icon: Fingerprint,
      page: 'memories' as const,
    },
    {
      label: '等待你的确认',
      value: pending.length,
      note: '每个判断都由你决定',
      icon: Sparkles,
      page: 'memories' as const,
    },
    {
      label: '收集的原始信息',
      value: snapshot.observationCount,
      note: `${snapshot.pendingAnalysis} 条等待分析`,
      icon: Database,
      page: 'sources' as const,
    },
    {
      label: '已启用的信息源',
      value: snapshot.sources.filter((source) => source.enabled).length,
      note: `${snapshot.devices.length} 个已注册设备`,
      icon: Waypoints,
      page: 'sources' as const,
    },
  ];
  return (
    <>
      <PageTitle
        eyebrow="YOUR PERSONAL SPACE"
        title="让每一次对话，更懂你一点。"
        description="把日常里的习惯、偏好与想法，慢慢整理成属于你的记忆。"
        actions={
          <button className="button primary" onClick={() => setEditor('new')}>
            <Plus size={17} /> 添加记忆
          </button>
        }
      />
      <section className="hero">
        <div className="hero-copy">
          <span className="hero-label">
            <span /> 记忆正在生长
          </span>
          <h2>不必每次，都从自我介绍开始。</h2>
          <p>
            连接日常对话，发现属于你的细节。
            <br />
            将确认后的记忆交给 AI，让帮助更合心意。
          </p>
          <button className="hero-link" onClick={() => navigate('sources')}>
            连接一个信息来源 <ArrowUpRight size={17} />
          </button>
        </div>
        <div className="memory-orbit" aria-hidden="true">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="orbit orbit-three" />
          <div className="orbit-center">
            <Leaf size={42} strokeWidth={1.1} />
          </div>
          <span className="orbit-dot dot-one" />
          <span className="orbit-dot dot-two" />
          <span className="orbit-chip chip-one">你的偏好</span>
          <span className="orbit-chip chip-two">日常习惯</span>
          <span className="orbit-chip chip-three">未来计划</span>
          <span className="orbit-caption">A LITTLE MORE YOU, EVERY DAY.</span>
        </div>
      </section>
      <div className="stats-grid">
        {stats.map(({ label, value, note, icon: Icon, page }) => (
          <button className="stat" key={label} onClick={() => navigate(page)}>
            <div>
              <span>{label}</span>
              <Icon size={18} strokeWidth={1.6} />
            </div>
            <strong>{String(value).padStart(2, '0')}</strong>
            <small>{note}</small>
          </button>
        ))}
      </div>
      {pending.length > 0 && (
        <div className="review-banner">
          <span className="banner-icon">
            <Sparkles size={20} />
          </span>
          <div>
            <strong>发现了 {pending.length} 条关于你的新线索</strong>
            <p>确认之后，它们才会成为个性化服务的依据。</p>
          </div>
          <button className="button secondary" onClick={() => navigate('memories')}>
            去看看 <ArrowRight size={15} />
          </button>
        </div>
      )}
      <div className="overview-grid">
        <section>
          <div className="section-heading">
            <h2>
              最近的记忆 <span>RECENT MEMORIES</span>
            </h2>
            <button className="text-button" onClick={() => navigate('memories')}>
              查看全部 <ArrowRight size={15} />
            </button>
          </div>
          {recent.length ? (
            <div className="memory-grid overview-memories">
              {recent.map((memory) => (
                <MemoryCard key={memory.id} memory={memory} onEdit={setEditor} compact />
              ))}
            </div>
          ) : (
            <div className="panel">
              <Empty
                title="从一件小事开始认识你"
                description="写下你偏爱的沟通方式、正在坚持的习惯，或想实现的小目标。"
                action={
                  <button className="button secondary" onClick={() => setEditor('new')}>
                    <Plus size={16} /> 添加第一条记忆
                  </button>
                }
              />
            </div>
          )}
        </section>
        <aside className="overview-aside">
          <section className="panel coverage">
            <div className="section-heading">
              <h2>关于你的拼图</h2>
              <Fingerprint size={18} />
            </div>
            <p className="muted">六个维度，逐渐完整。</p>
            <div className="coverage-list">
              {Object.entries(categoryLabels).map(([category, label]) => {
                const count = confirmed.filter((memory) => memory.category === category).length;
                return (
                  <div className="coverage-row" key={category}>
                    <span className={`category-dot category-${category}`} />
                    <span>{label}</span>
                    <div className="progress-track">
                      <i style={{ width: `${Math.min(100, count * 14)}%` }} />
                    </div>
                    <strong>{count}</strong>
                  </div>
                );
              })}
            </div>
            <div className="coverage-foot">
              <CircleCheck size={14} /> 仅统计已确认的资料
            </div>
          </section>
          <section className="panel activity">
            <div className="section-heading">
              <h2>分析动态</h2>
              <Clock3 size={17} />
            </div>
            {snapshot.analysisRuns.length ? (
              snapshot.analysisRuns.slice(0, 3).map((run) => (
                <div className="activity-row" key={run.id}>
                  <span className={`activity-dot ${run.status}`} />
                  <div>
                    <strong>
                      {run.status === 'succeeded'
                        ? `生成了 ${run.proposed} 条候选资料`
                        : run.status === 'running'
                          ? '正在梳理原始信息'
                          : '分析未完成'}
                    </strong>
                    <small>
                      {formatTime(run.updatedAt)} · {run.count} 条信息
                    </small>
                  </div>
                </div>
              ))
            ) : (
              <p className="small muted">还没有分析记录。上传一些日常对话，开始发现你的偏好。</p>
            )}
            <button
              className="text-button"
              disabled={busy || !snapshot.system.aiConfigured || !snapshot.pendingAnalysis}
              onClick={() =>
                void mutate(() => client.call('analysis.run', {}), '分析完成，请确认新资料')
              }
            >
              <Sparkles size={14} />{' '}
              {snapshot.system.aiConfigured ? '分析待处理信息' : '配置模型后开启分析'}{' '}
              <ArrowRight size={14} />
            </button>
          </section>
        </aside>
      </div>
      {editor && (
        <MemoryEditor
          memory={editor === 'new' ? undefined : editor}
          onClose={() => setEditor(null)}
        />
      )}
    </>
  );
}

export function Memories() {
  const { snapshot } = useAssistant();
  const [editor, setEditor] = useState<Memory | 'new' | null>(null);
  const [category, setCategory] = useState('all');
  const [status, setStatus] = useState('all');
  const [query, setQuery] = useState('');
  const items = snapshot.memories.filter(
    (memory) =>
      (category === 'all' || memory.category === category) &&
      (status === 'all' || memory.status === status) &&
      [memory.title, memory.content, ...memory.tags]
        .join(' ')
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <>
      <PageTitle
        eyebrow="YOUR MEMORY LIBRARY"
        title="关于你的，每一个细节。"
        description="确认、修正或放下。你的个人资料始终由你决定。"
        actions={
          <button className="button primary" onClick={() => setEditor('new')}>
            <Plus size={17} /> 添加记忆
          </button>
        }
      />
      <div className="filter-bar">
        <div className="tabs">
          {[
            ['all', '全部资料'],
            ['confirmed', '已确认'],
            ['proposed', '待确认'],
            ['rejected', '已忽略'],
          ].map(([value, label]) => (
            <button
              key={value}
              className={status === value ? 'selected' : ''}
              onClick={() => setStatus(value!)}
            >
              {label}
              <span>
                {
                  snapshot.memories.filter((memory) => value === 'all' || memory.status === value)
                    .length
                }
              </span>
            </button>
          ))}
        </div>
        <div className="search">
          <Search size={16} />
          <input
            aria-label="搜索资料"
            placeholder="搜索记忆、标签…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>
      <div className="category-filters">
        <button className={category === 'all' ? 'selected' : ''} onClick={() => setCategory('all')}>
          全部维度
        </button>
        {Object.entries(categoryLabels).map(([key, label]) => (
          <button
            key={key}
            className={category === key ? 'selected' : ''}
            onClick={() => setCategory(key)}
          >
            <span className={`category-dot category-${key}`} />
            {label}
          </button>
        ))}
        <span className="result-count">{items.length} 条记忆</span>
      </div>
      {items.length ? (
        <div className="memory-grid library-grid">
          {items.map((memory) => (
            <MemoryCard key={memory.id} memory={memory} onEdit={setEditor} />
          ))}
        </div>
      ) : (
        <div className="panel">
          <Empty
            title="这里还没有记忆"
            description="添加一条个人资料，或从信息来源中提取新的线索。"
            action={
              <button className="button secondary" onClick={() => setEditor('new')}>
                <Plus size={15} /> 添加记忆
              </button>
            }
          />
        </div>
      )}
      {editor && (
        <MemoryEditor
          memory={editor === 'new' ? undefined : editor}
          onClose={() => setEditor(null)}
        />
      )}
    </>
  );
}
