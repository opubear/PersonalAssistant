import { useState } from 'react';
import {
  Plus,
  Sparkles,
  Check,
  X,
  Pencil,
  Trash2,
  Monitor,
  FilePenLine,
  Download,
  Play,
} from 'lucide-react';
import { type Job } from '@qiyi/contracts';
import { useAssistant } from '../state.js';
import { client, formatTime, syncLocal } from '../api.js';
import { Empty, PageTitle, StatusBadge } from '../components.js';
import { JobEditor } from './JobEditor.js';

export function Actions() {
  const { snapshot, local, busy, mutate, confirm } = useAssistant();
  const [editor, setEditor] = useState<Job | 'new' | null>(null);
  const devicesWithTools = snapshot.devices.filter((device) => device.tools.length);
  return (
    <>
      <PageTitle
        eyebrow="A HELPING HAND"
        title="把记忆，变成行动。"
        description="让本机工具接手一些小事。查看参数、批准执行，每一步都有记录。"
        actions={
          <button
            className="button primary"
            disabled={!devicesWithTools.length}
            onClick={() => setEditor('new')}
          >
            <Plus size={17} /> 创建行动
          </button>
        }
      />
      <div className="notice">
        <Sparkles size={17} />
        <span>任务经你批准后，由指定设备执行。关闭页面后，后台服务仍可继续工作。</span>
      </div>
      <div className="section-heading">
        <h2>
          可用工具 <span>LOCAL CAPABILITIES</span>
        </h2>
        <button
          className="text-button"
          disabled={busy}
          onClick={() => void mutate(syncLocal, '本机工具状态已更新')}
        >
          <Play size={14} /> 同步并执行已批准任务
        </button>
      </div>
      {devicesWithTools.length ? (
        <div className="tool-grid">
          {devicesWithTools.flatMap((device) =>
            device.tools.map((tool) => (
              <article className="panel tool-card" key={`${device.id}:${tool.id}`}>
                <span className="tool-icon">
                  {tool.id === 'notes.create' ? (
                    <FilePenLine size={23} />
                  ) : tool.id === 'profile.export' ? (
                    <Download size={23} />
                  ) : (
                    <Sparkles size={23} />
                  )}
                </span>
                <h3>{tool.title}</h3>
                <p>{tool.description}</p>
                <div>
                  <span>
                    <Monitor size={13} />
                    {device.id === local?.deviceId ? '本机' : device.name}
                  </span>
                  <code>{tool.id}</code>
                </div>
              </article>
            )),
          )}
        </div>
      ) : (
        <div className="panel">
          <Empty
            title="等待本机工具连接"
            description="启动本机桥接或独立后台服务后，这里会出现它提供的工具。"
          />
        </div>
      )}
      <div className="section-heading records-heading">
        <h2>
          行动记录 <span>{snapshot.jobs.length} 个任务</span>
        </h2>
      </div>
      {snapshot.jobs.length ? (
        <div className="job-list">
          {snapshot.jobs.map((job) => (
            <article className="panel job-card" key={job.id}>
              <div className="job-main">
                <span className="job-icon">
                  <Sparkles size={20} />
                </span>
                <div>
                  <h3>{job.title}</h3>
                  <p>
                    {job.toolId} <span>·</span> {job.deviceId} <span>·</span>{' '}
                    {formatTime(job.createdAt)}
                  </p>
                </div>
                <StatusBadge status={job.status} />
              </div>
              <details>
                <summary>参数与执行结果</summary>
                <pre>{JSON.stringify(job.input, null, 2)}</pre>
                {job.result && <div className="result-box">{job.result}</div>}
                {job.error && <div className="notice warning">{job.error}</div>}
              </details>
              <div className="job-actions">
                {job.status === 'pending' && (
                  <>
                    <button
                      className="button primary small-button"
                      disabled={busy}
                      onClick={() =>
                        void mutate(
                          () =>
                            client.call('jobs.decide', {
                              id: job.id,
                              revision: job.revision,
                              decision: 'approve',
                            }),
                          '已批准，指定设备将在下次同步时执行',
                        )
                      }
                    >
                      <Check size={15} /> 批准执行
                    </button>
                    <button
                      className="button secondary small-button"
                      onClick={() => setEditor(job)}
                    >
                      <Pencil size={14} /> 修改
                    </button>
                  </>
                )}
                {['pending', 'approved'].includes(job.status) && (
                  <button
                    className="text-button"
                    disabled={busy}
                    onClick={() =>
                      void mutate(
                        () =>
                          client.call('jobs.decide', {
                            id: job.id,
                            revision: job.revision,
                            decision: 'cancel',
                          }),
                        '任务已取消',
                      )
                    }
                  >
                    <X size={15} /> 取消任务
                  </button>
                )}
                {!['approved', 'running'].includes(job.status) && (
                  <button
                    className="icon-button danger-text job-delete"
                    aria-label={`删除任务 ${job.title}`}
                    onClick={() =>
                      confirm(
                        '删除这条行动记录？',
                        '删除记录不会撤销已经完成的本机操作或移除输出文件。',
                        () => client.call('jobs.delete', { id: job.id, revision: job.revision }),
                      )
                    }
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="panel">
          <Empty
            title="让助手替你做一件小事"
            description="比如保存一份计划，或导出可供其他 Agent 使用的个人上下文。"
            action={
              <button
                className="button secondary"
                disabled={!devicesWithTools.length}
                onClick={() => setEditor('new')}
              >
                <Plus size={16} /> 创建第一个行动
              </button>
            }
          />
        </div>
      )}
      {editor && (
        <JobEditor job={editor === 'new' ? undefined : editor} onClose={() => setEditor(null)} />
      )}
    </>
  );
}
