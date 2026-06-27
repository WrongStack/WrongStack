/**
 * SidePanel — the secondary panel next to the ActivityBar.
 *
 * One activity icon = one full panel (VS Code model). The panel content is
 * routed off `activeActivity` so clicking a different icon actually switches
 * what you see — no shared accordion.
 */

import { PanelLeftClose } from 'lucide-react';
import { useEffect } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import {
  type Activity,
  SIDEBAR_DEFAULT_WIDTH,
  useConfigStore,
  useFileStore,
  useSessionStore,
  useUIStore,
} from '@/stores';
import { FileExplorer } from '../FileExplorer';
import { MailboxPanel } from '../MailboxPanel';
import { ProjectsPanel } from '../ProjectsPanel';
import { Button } from '../ui/button';
import { AgentsPanel } from './AgentsPanel';
import { ChangesPanel } from './ChangesPanel';
import { HistoryPanel } from './HistoryPanel';
import { SessionPanel } from './SessionPanel';
import { SkillsList } from './SkillsList';
import { DesignStudioPanel } from './DesignStudioPanel';
import { OfficeMapSettingsPanel } from '../OfficeMapSettingsPanel';

const PANEL_TITLE: Record<Activity, string> = {
  chat: 'Session',
  agents: 'Agents',
  history: 'History',
  files: 'Files',
  changes: 'Changes',
  projects: 'Projects',
  mailbox: 'Mailbox',
  skills: 'Skills',
  design: 'Design Studio',
  officemap: 'Office Map',
};

export function SidePanel() {
  const activeActivity = useUIStore((s) => s.activeActivity);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth);
  const wsConnected = useConfigStore((s) => s.wsConnected);
  const { client } = useWebSocket();

  // Load the file tree when the Files panel is shown.
  useEffect(() => {
    if (activeActivity !== 'files' || !wsConnected) return;
    useFileStore.getState().setTreeLoading(true);
    const cwd = useSessionStore.getState().cwd;
    client?.send({ type: 'files.tree', payload: cwd ? { path: cwd } : {} });
  }, [activeActivity, wsConnected, client]);

  // Drag-to-resize. The store owns the clamp — no local bounds here.
  const startDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = sidebarWidth;
    const onMove = (ev: MouseEvent) => setSidebarWidth(startWidth + (ev.clientX - startX));
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  return (
    <aside
      style={{ width: `${sidebarWidth}px` }}
      className="relative border-r bg-card flex flex-col shrink-0 overflow-hidden animate-slide-in"
    >
      {/* Drag handle */}
      <div
        onMouseDown={startDrag}
        onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
        className="group/handle absolute top-0 right-0 h-full w-2 cursor-col-resize z-10 flex items-center justify-end"
        title="Drag to resize · double-click to reset"
      >
        <div className="h-full w-px bg-border group-hover/handle:bg-primary/60 group-hover/handle:w-0.5 transition-all" />
      </div>

      {/* Panel header — names the active panel */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b shrink-0">
        <span className="text-xs font-semibold tracking-tight text-muted-foreground uppercase">
          {PANEL_TITLE[activeActivity]}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6"
          onClick={() => setSidebarOpen(false)}
          title="Collapse panel (Ctrl+\)"
        >
          <PanelLeftClose className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Panel body — routed by activity */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {activeActivity === 'chat' && <SessionPanel />}
        {activeActivity === 'agents' && <AgentsPanel />}
        {activeActivity === 'history' && <HistoryPanel />}
        {activeActivity === 'files' && (
          <div className="flex-1 overflow-y-auto">
            <FileExplorer />
          </div>
        )}
        {activeActivity === 'changes' && <ChangesPanel />}
        {activeActivity === 'projects' && (
          <div className="flex-1 overflow-y-auto p-3">
            <ProjectsPanel />
          </div>
        )}
        {activeActivity === 'mailbox' && (
          <div className="flex-1 overflow-y-auto p-3">
            <MailboxPanel />
          </div>
        )}
        {activeActivity === 'skills' && (
          <div className="flex-1 overflow-hidden">
            <SkillsList className="h-full" />
          </div>
        )}
        {activeActivity === 'design' && (
          <div className="flex-1 overflow-hidden">
            <DesignStudioPanel className="h-full" />
          </div>
        )}
        {activeActivity === 'officemap' && (
          <div className="flex-1 overflow-hidden">
            <OfficeMapSettingsPanel />
          </div>
        )}
      </div>
    </aside>
  );
}
