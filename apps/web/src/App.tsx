import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LayoutDashboard,
  Fingerprint,
  Waypoints,
  Sparkles,
  SlidersHorizontal,
  PanelLeftClose,
  ArrowUpRight,
  Check,
  X,
  Menu,
  Leaf,
  LockKeyhole,
  RefreshCw,
  CircleHelp,
  BookOpenText,
} from 'lucide-react';
import type { Snapshot } from '@qiyi/contracts';
import { client, localStatus, type LocalStatus } from './api.js';
import { AssistantContext, type Page } from './state.js';
import { Modal } from './components.js';
import { Overview, Memories } from './pages/Memories.js';
import { Sources } from './pages/Sources.js';
import { Actions } from './pages/Actions.js';
import { ContextPage, Settings } from './pages/Settings.js';

const navigation = [
  { id: 'overview', label: '空间概览', icon: LayoutDashboard },
  { id: 'memories', label: '我的资料', icon: Fingerprint },
  { id: 'sources', label: '信息来源', icon: Waypoints },
  { id: 'actions', label: '自动行动', icon: Sparkles },
  { id: 'context', label: '个性化上下文', icon: BookOpenText },
] as const;

export function App() {
  const [page, setPage] = useState<Page>('overview');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [local, setLocal] = useState<LocalStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [menu, setMenu] = useState(false);
  const [toast, setToast] = useState<{ message: string; error: boolean } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshSequence = useRef(0);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    description: string;
    work: () => Promise<unknown>;
  } | null>(null);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequence.current;
    const [remote, localResult] = await Promise.allSettled([
      client.call('snapshot.get', {}),
      localStatus(),
    ]);
    if (sequence !== refreshSequence.current) return;
    if (remote.status === 'rejected') throw remote.reason;
    setSnapshot(remote.value);
    setError(null);
    if (localResult.status === 'fulfilled') setLocal(localResult.value);
  }, []);

  useEffect(() => {
    const load = () => {
      void refresh().catch((error) =>
        setError(error instanceof Error ? error.message : String(error)),
      );
    };
    load();
    const interval = setInterval(load, 15000);
    return () => {
      clearInterval(interval);
      clearTimeout(toastTimer.current);
    };
  }, [refresh]);

  const notify = (message: string, error = false) => {
    clearTimeout(toastTimer.current);
    setToast({ message, error });
    toastTimer.current = setTimeout(() => setToast(null), error ? 10000 : 4500);
  };
  const mutate = async (work: () => Promise<unknown>, message = '操作已完成') => {
    if (busy) return false;
    setBusy(true);
    try {
      await work();
      try {
        await refresh();
        notify(message);
      } catch {
        notify('操作已保存，但刷新失败。请恢复连接后刷新页面。', true);
      }
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const navigate = (next: Page) => {
    setPage(next);
    setMenu(false);
    window.scrollTo({ top: 0 });
  };
  const pending = snapshot?.memories.filter((memory) => memory.status === 'proposed').length ?? 0;
  const activeLabel =
    page === 'settings' ? '空间设置' : navigation.find((item) => item.id === page)?.label;

  return (
    <div className="app-shell">
      <aside className={`sidebar ${menu ? 'mobile-open' : ''}`}>
        <button className="brand" onClick={() => navigate('overview')} aria-label="栖忆首页">
          <span className="brand-mark">
            <Leaf size={25} strokeWidth={1.7} />
          </span>
          <span>
            <strong>
              栖忆<span className="brand-period">.</span>
            </strong>
            <small>PERSONAL MEMORY</small>
          </span>
        </button>
        <div className="workspace-switch">
          <span className="avatar">{snapshot?.profile.name.slice(0, 1) ?? '我'}</span>
          <span>
            <strong>个人空间</strong>
            <small>一个更懂你的地方</small>
          </span>
          <LockKeyhole size={13} />
        </div>
        <div className="nav-heading">我的工作台</div>
        <nav>
          {navigation.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${page === id ? 'active' : ''}`}
              onClick={() => navigate(id)}
            >
              <Icon size={18} strokeWidth={1.7} />
              <span>{label}</span>
              {id === 'memories' && pending > 0 && <span className="nav-count">{pending}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="privacy-card">
            <span>
              <LockKeyhole size={16} /> 你的记忆，由你掌握
            </span>
            <p>每条信息都可查看、编辑与删除。只保留你认可的自己。</p>
          </div>
          <button
            className={`nav-item ${page === 'settings' ? 'active' : ''}`}
            onClick={() => navigate('settings')}
          >
            <SlidersHorizontal size={18} />
            <span>空间设置</span>
          </button>
          <div className="sidebar-foot">
            <span>栖忆 · 0.1</span>
            <PanelLeftClose size={15} />
          </div>
        </div>
      </aside>
      {menu && (
        <button className="sidebar-backdrop" onClick={() => setMenu(false)} aria-label="收起导航" />
      )}
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setMenu(!menu)}
            >
              <Menu size={20} />
            </button>
            <span>个人空间</span>
            <span className="slash">/</span>
            <strong>{activeLabel}</strong>
          </div>
          <div className="topbar-right">
            <span className={`connection ${error ? 'offline' : ''}`}>
              <i />
              {error ? '连接中断' : local?.transport === 'ssh' ? 'SSH 已连接' : '本机已连接'}
            </span>
            <button
              className="icon-button"
              aria-label="刷新数据"
              onClick={() => void refresh().catch((error) => notify(String(error), true))}
            >
              <RefreshCw size={16} className={busy ? 'spin' : ''} />
            </button>
            <button
              className="user-avatar"
              aria-label="编辑个人信息"
              onClick={() => navigate('settings')}
            >
              {snapshot?.profile.name.slice(0, 1) ?? '我'}
            </button>
          </div>
        </header>
        <main>
          {error && (
            <div className="connection-error">
              <CircleHelp size={18} />
              <span>{error}</span>
              <button onClick={() => void refresh().catch((error) => setError(String(error)))}>
                重试 <ArrowUpRight size={14} />
              </button>
            </div>
          )}
          {snapshot ? (
            <AssistantContext.Provider
              value={{
                snapshot,
                local,
                busy,
                navigate,
                mutate,
                notify,
                refresh,
                confirm: (title, description, work) =>
                  setConfirmation({ title, description, work }),
              }}
            >
              {page === 'overview' && <Overview />}
              {page === 'memories' && <Memories />}
              {page === 'sources' && <Sources />}
              {page === 'actions' && <Actions />}
              {page === 'context' && <ContextPage />}
              {page === 'settings' && <Settings />}
            </AssistantContext.Provider>
          ) : (
            <div className="loading">
              <Leaf size={35} />
              <h2>{error ? '暂时无法连接个人空间' : '正在打开你的个人空间…'}</h2>
              <p>{error ? '请确认后端和本机桥接服务已经启动。' : '让记忆慢慢生长。'}</p>
            </div>
          )}
          <footer className="main-footer">
            <span>
              <Leaf size={13} /> 留下重要的，让日常更轻盈。
            </span>
            <span>PRIVATE BY DESIGN</span>
          </footer>
        </main>
      </div>
      {toast && (
        <div
          role={toast.error ? 'alert' : 'status'}
          className={`toast ${toast.error ? 'error' : ''}`}
        >
          {toast.error ? <CircleHelp size={18} /> : <Check size={18} />}
          <span>{toast.message}</span>
          <button className="icon-button" onClick={() => setToast(null)} aria-label="关闭提示">
            <X size={16} />
          </button>
        </div>
      )}
      {confirmation && (
        <Modal
          title={confirmation.title}
          description={confirmation.description}
          onClose={() => setConfirmation(null)}
        >
          <div className="form-actions">
            <button className="button secondary" onClick={() => setConfirmation(null)}>
              取消
            </button>
            <button
              className="button danger"
              disabled={busy}
              onClick={async () => {
                if (await mutate(confirmation.work)) setConfirmation(null);
              }}
            >
              确认删除
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
