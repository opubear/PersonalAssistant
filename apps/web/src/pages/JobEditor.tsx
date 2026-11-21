import { useState, type FormEvent } from 'react';
import type { Job, JobInput } from '@qiyi/contracts';
import { client } from '../api.js';
import { Modal } from '../components.js';
import { useAssistant } from '../state.js';

export function JobEditor({ job, onClose }: { job?: Job; onClose: () => void }) {
  const { snapshot, mutate, busy, notify } = useAssistant();
  const [form, setForm] = useState<JobInput>(() => {
    // Keep an existing target even when it is unavailable. Only the user may replace it.
    if (job)
      return { deviceId: job.deviceId, toolId: job.toolId, title: job.title, input: job.input };

    const device = snapshot.devices.find((item) => item.tools.length);
    const tool = device?.tools[0];
    return {
      deviceId: device?.id ?? '',
      toolId: tool?.id ?? '',
      title: tool?.title ?? '',
      input: tool?.example ?? {},
    };
  });
  const [input, setInput] = useState(JSON.stringify(form.input, null, 2));
  // Derive availability from every snapshot, including updates while the editor is open.
  const device = snapshot.devices.find((item) => item.id === form.deviceId);
  const tools = device?.tools ?? [];
  const targetAvailable = tools.some((tool) => tool.id === form.toolId);
  const availableDevices = snapshot.devices.filter((item) => item.tools.length);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!targetAvailable) {
      notify('所选工具已不可用，请先选择可用设备和工具。', true);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
    } catch {
      notify('参数必须是有效的 JSON 对象', true);
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      notify('参数必须是有效的 JSON 对象', true);
      return;
    }
    const params = { ...form, input: parsed as Record<string, unknown> };
    if (
      await mutate(
        () =>
          job
            ? client.call('jobs.update', { ...params, id: job.id, revision: job.revision })
            : client.call('jobs.create', params),
        job ? '任务已保存' : '任务已创建，请检查参数后批准执行',
      )
    )
      onClose();
  };

  const cancelJob = async () => {
    if (!job) return;
    if (
      await mutate(
        () =>
          client.call('jobs.decide', { id: job.id, revision: job.revision, decision: 'cancel' }),
        '任务已取消',
      )
    )
      onClose();
  };

  return (
    <Modal
      title={job ? '编辑行动' : '创建一个行动'}
      description="先保存任务，再明确批准。执行端只调用已注册的工具。"
      onClose={onClose}
    >
      <form className="editor-form" onSubmit={(event) => void submit(event)}>
        {!targetAvailable && (
          <div className="notice warning" role="status">
            {job
              ? '所选工具已不可用。请选择可用设备和工具，或取消此任务。'
              : '当前没有选中可用工具，请等待设备连接或选择其他设备。'}
          </div>
        )}
        <label>
          任务名称
          <input
            required
            maxLength={160}
            value={form.title}
            onChange={(event) => setForm({ ...form, title: event.target.value })}
            autoFocus
          />
        </label>
        <div className="form-row">
          <label>
            执行设备
            <select
              value={form.deviceId}
              onChange={(event) => {
                const next = snapshot.devices.find((item) => item.id === event.target.value);
                const tool = next?.tools[0];
                if (!next || !tool) {
                  notify('此设备已没有可用工具，请重新选择。', true);
                  return;
                }
                setForm({ ...form, deviceId: next.id, toolId: tool.id });
                setInput(JSON.stringify(tool.example, null, 2));
              }}
            >
              {!availableDevices.some((item) => item.id === form.deviceId) && (
                <option value={form.deviceId} disabled>
                  {form.deviceId
                    ? `${device?.name ?? form.deviceId}（暂无可用工具）`
                    : '暂无可用设备'}
                </option>
              )}
              {availableDevices.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.id})
                </option>
              ))}
            </select>
          </label>
          <label>
            工具
            <select
              value={form.toolId}
              disabled={!tools.length}
              onChange={(event) => {
                const tool = tools.find((item) => item.id === event.target.value);
                if (!tool) {
                  notify('此工具已不可用，请重新选择。', true);
                  return;
                }
                setForm({ ...form, toolId: tool.id, title: tool.title });
                setInput(JSON.stringify(tool.example, null, 2));
              }}
            >
              {!targetAvailable && (
                <option value={form.toolId} disabled>
                  {form.toolId ? `已下线：${form.toolId}` : '暂无可用工具'}
                </option>
              )}
              {tools.map((tool) => (
                <option key={tool.id} value={tool.id}>
                  {tool.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label>
          工具参数
          <textarea
            aria-label="工具参数 JSON"
            className="code-input"
            rows={7}
            value={input}
            onChange={(event) => setInput(event.target.value)}
          />
        </label>
        <div className="form-actions">
          <button type="button" className="button secondary" onClick={onClose}>
            关闭
          </button>
          {job && ['pending', 'approved'].includes(job.status) && (
            <button
              type="button"
              className="text-button danger-text"
              disabled={busy}
              onClick={() => void cancelJob()}
            >
              取消任务
            </button>
          )}
          <button className="button primary" disabled={busy || !targetAvailable}>
            {job ? '保存修改' : '创建待批准任务'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
