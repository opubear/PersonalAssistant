import { AssistantClient, HttpTransport } from '@qiyi/client';
import type { RuntimeStatus } from '@qiyi/adapters';

export const client = new AssistantClient(new HttpTransport('/api/rpc'));
export type LocalStatus = RuntimeStatus & { transport: string };
export async function localStatus(): Promise<LocalStatus> {
  const response = await fetch('/api/local/status');
  if (!response.ok) throw new Error('本机桥接服务不可用');
  return response.json() as Promise<LocalStatus>;
}
export async function syncLocal(): Promise<void> {
  const response = await fetch('/api/local/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const body = (await response.json()) as { ok: boolean; error?: { message: string } };
  if (!response.ok || !body.ok) throw new Error(body.error?.message ?? '同步失败');
}
export function download(name: string, content: string, type = 'application/json'): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function formatTime(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}
