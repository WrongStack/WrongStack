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
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  useConfigStore,
  useFileStore,
  useSessionStore,
  useUIStore,
} from '@/stores';
import { FileExplorer } from '../FileExplorer';
import { MailboxPanel } from '../MailboxPanel';
import { Button } from '../ui/button';
import { ChangesPanel } from './ChangesPanel';
import { SessionPanel } from './SessionPanel';
import { SkillsList } from './SkillsList';
import { DesignStudioPanel } from './DesignStudioPanel';
import { AgentsPanel } from './AgentsPanel';

const PANEL_DESCRIPTIONS: Record<string, string> = {
  chat: 'Run state, model, context and quick controls',
  agents: 'Live fleet roster and agent monitoring',
  files: 'Browse and open project files',
  changes: 'Review source control changes',
  mailbox: 'Cross-surface coordination messages',
  skills: 'Installed skills and capability docs',
  design: 'Design studio assets and previews',
};

export function SidePanel({ desktopShell = false }: { desktopShell?: boolean | undefined }) {
  const activeActivity = useUIStore((s) => s.activeActivity);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth);
  const wsConnected = useConfigStore((s) => s.wsConnected);
  const { client } = useWebSocket();
  const { t } = useAppTranslation();
  const panelWidth = desktopShell
    ? `min(${Math.min(sidebarWidth, 280)}px, calc(100vw - 2.5rem))`
    : `min(${sidebarWidth}px, calc(100vw - 3rem))`;

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
    <>
      <div
        className={cn(
          'fixed inset-y-0 right-0 z-30 bg-black/35 backdrop-blur-[2px] md:hidden',
          desktopShell ? 'left-10' : 'left-12',
        )}
        onClick={() => setSidebarOpen(false)}
        aria-hidden="true"
      />
      <aside
        style={{
          width: panelWidth,
        }}
        role="dialog"
        aria-modal="true"
        aria-label={t('activity:sidebar.label')}
        className={cn(
          'fixed inset-y-0 z-40 flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden border-r border-border/70 bg-card/95 shadow-2xl backdrop-blur-xl animate-slide-in md:relative md:inset-auto md:z-auto md:shadow-none',
          desktopShell ? 'left-10' : 'left-12',
        )}
      >
      {/* Drag handle */}
      <hr
        aria-orientation="vertical"
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        aria-valuenow={sidebarWidth}
        tabIndex={0}
        onMouseDown={startDrag}
        onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
        className="group/handle absolute top-0 right-0 z-10 m-0 h-full w-2 cursor-col-resize border-0 border-r border-border/70 hover:border-primary/70"
        title={t('activity:sidePanel.dragHint')}
      />

      {/* Panel header — names the active panel */}
      <div
        className={cn(
          'flex items-center justify-between border-b shrink-0',
          'bg-muted/25',
          desktopShell ? 'px-2.5 py-2' : 'px-3 py-3',
        )}
      >
        <div className="min-w-0">
          <div className="text-sm font-semibold text-foreground">
            {t(`activity:nav.${activeActivity}`)}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
            {PANEL_DESCRIPTIONS[activeActivity]}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0"
          onClick={() => setSidebarOpen(false)}
          title={t('activity:sidePanel.collapse')}
        >
          <PanelLeftClose className="h-3.5 w-3.5" />
        </Button>
      </div>

      {/* Panel body — routed by activity */}
      <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden">
        {activeActivity === 'chat' && <SessionPanel />}
        {activeActivity === 'agents' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overscroll-contain">
            <AgentsPanel />
          </div>
        )}
        {activeActivity === 'files' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overscroll-contain">
            <FileExplorer />
          </div>
        )}
        {activeActivity === 'changes' && <ChangesPanel />}
        {activeActivity === 'mailbox' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overscroll-contain p-3">
            <MailboxPanel />
          </div>
        )}
        {activeActivity === 'skills' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <SkillsList className="h-full" />
          </div>
        )}
        {activeActivity === 'design' && (
          <div className="flex-1 min-h-0 min-w-0 overflow-hidden">
            <DesignStudioPanel className="h-full" />
          </div>
        )}
      </div>
      </aside>
    </>
  );
}
