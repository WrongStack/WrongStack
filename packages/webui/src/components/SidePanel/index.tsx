/**
 * SidePanel — the secondary panel next to the ActivityBar.
 *
 * One activity icon = one full panel (VS Code model). The panel content is
 * routed off `activeActivity` so clicking a different icon actually switches
 * what you see — no shared accordion.
 */

import { PanelLeftClose } from 'lucide-react';
import { useEffect } from 'react';
import { useViewport } from '@/hooks/useViewport';
import { useWebSocket } from '@/hooks/useWebSocket';
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
import { AgentsPanel } from './AgentsPanel';
import { ChangesPanel } from './ChangesPanel';
import { DesignStudioPanel } from './DesignStudioPanel';
import { SessionPanel } from './SessionPanel';
import { SkillsList } from './SkillsList';
import { StoryWidget } from './StoryWidget';

export function SidePanel() {
  const activeActivity = useUIStore((s) => s.activeActivity);
  const setSidebarOpen = useUIStore((s) => s.setSidebarOpen);
  const sidebarWidth = useUIStore((s) => s.sidebarWidth);
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth);
  const wsConnected = useConfigStore((s) => s.wsConnected);
  const { client } = useWebSocket();
  const { t } = useAppTranslation();
  const { width } = useViewport();
  const isOverlay = width > 0 && width < 768;
  const panelWidth = `min(${sidebarWidth}px, calc(100vw - 3rem))`;

  // Load the file tree when the Files panel is shown.
  useEffect(() => {
    if (activeActivity !== 'files' || !wsConnected) return;
    useFileStore.getState().setTreeLoading(true);
    const cwd = useSessionStore.getState().cwd;
    client?.send({ type: 'files.tree', payload: client.withSession(cwd ? { path: cwd } : {}) });
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
        className="fixed inset-0 z-30 bg-black/35 backdrop-blur-[2px] md:hidden"
        onClick={() => setSidebarOpen(false)}
        aria-hidden="true"
      />
      <aside
        style={{
          width: panelWidth,
        }}
        {...(isOverlay
          ? { role: 'dialog', 'aria-modal': true as const }
          : { role: 'complementary' })}
        aria-label={t('activity:sidebar.label')}
        className="ws-side-panel fixed inset-y-0 left-0 z-40 flex min-h-0 min-w-0 shrink-0 flex-col overflow-hidden border-r border-border/70 backdrop-blur-xl animate-slide-in md:relative md:inset-auto md:z-auto md:shadow-none"
      >
        {/* Resize handle. Was an `<hr>` carrying aria-valuemin/max/now with no
            role: those properties are only meaningful on a focusable separator,
            so AT had no widget to expose and the drag was mouse-only. Now an
            explicit role="separator" that keyboard users can operate too. */}
        {/* biome-ignore lint/a11y/useSemanticElements: a focusable splitter widget; <hr> is a non-interactive thematic break. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label={t('activity:sidePanel.dragHint')}
          aria-valuemin={SIDEBAR_MIN_WIDTH}
          aria-valuemax={SIDEBAR_MAX_WIDTH}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onMouseDown={startDrag}
          onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 64 : 16;
            let next: number | null = null;
            if (e.key === 'ArrowLeft') next = sidebarWidth - step;
            else if (e.key === 'ArrowRight') next = sidebarWidth + step;
            else if (e.key === 'Home') next = SIDEBAR_MIN_WIDTH;
            else if (e.key === 'End') next = SIDEBAR_MAX_WIDTH;
            if (next === null) return;
            e.preventDefault();
            setSidebarWidth(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, next)));
          }}
          className="group/handle absolute top-0 right-0 z-10 h-full w-2 cursor-col-resize border-r border-border/70 hover:border-primary/70"
          title={t('activity:sidePanel.dragHint')}
        />

        {/* Panel header — names the active panel */}
        <div className="flex items-center justify-between border-b shrink-0 bg-muted/25 px-3 py-3">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-foreground">
              {t(`activity:nav.${activeActivity}`)}
            </div>
            <div className="mt-0.5 truncate text-[11px] text-muted-foreground">
              {t(`activity:sidePanel.${activeActivity}`)}
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
        <StoryWidget collapseOnOpen={isOverlay} />
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
