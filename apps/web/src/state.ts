import { createContext, useContext } from 'react';
import type { Snapshot } from '@qiyi/contracts';
import type { LocalStatus } from './api.js';

export type Page = 'overview' | 'memories' | 'sources' | 'actions' | 'context' | 'settings';
export type AssistantState = {
  snapshot: Snapshot;
  local: LocalStatus | null;
  busy: boolean;
  navigate: (page: Page) => void;
  mutate: (work: () => Promise<unknown>, message?: string) => Promise<boolean>;
  notify: (message: string, error?: boolean) => void;
  confirm: (title: string, description: string, work: () => Promise<unknown>) => void;
  refresh: () => Promise<void>;
};
export const AssistantContext = createContext<AssistantState | null>(null);
export function useAssistant(): AssistantState {
  const value = useContext(AssistantContext);
  if (!value) throw new Error('AssistantContext is missing');
  return value;
}
