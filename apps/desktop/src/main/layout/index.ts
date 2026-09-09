/**
 * Layout management for the desktop shell.
 * Handles window sizing, sidebar dimensions, and view arrangement.
 */
import type { BaseWindow, WebContentsView } from 'electron';
import type { IRuntimeManager } from '../state/types.js';
import { getSidebarWidth } from './sidebar.js';

export { getSidebarWidth } from './sidebar.js';

/**
 * Main layout function - updates both shell view and webui views.
 */
export function layoutViews(
  mainWindow: BaseWindow | null,
  shellView: WebContentsView | null,
  runtimeManager: IRuntimeManager,
  shellSidebarCollapsed: boolean,
  webuiViews: Map<string, { runtimeId: string; view: WebContentsView }>,
): void {
  if (!mainWindow || !shellView) return;

  const size = mainWindow.getContentSize();
  const width = size[0] ?? 0;
  const height = size[1] ?? 0;

  shellView.setBounds({ x: 0, y: 0, width, height });
  layoutWebuiViews(mainWindow, runtimeManager, shellSidebarCollapsed, webuiViews, width, height);
}

/**
 * Layout all WebUI views within the main window.
 * Only the active runtime's view is visible, others are hidden.
 */
export function layoutWebuiViews(
  mainWindow: BaseWindow | null,
  runtimeManager: IRuntimeManager,
  shellSidebarCollapsed: boolean,
  webuiViews: Map<string, { runtimeId: string; view: WebContentsView }>,
  windowWidth?: number,
  windowHeight?: number,
): void {
  if (!mainWindow) return;

  const size = mainWindow.getContentSize();
  const width = windowWidth ?? size[0] ?? 0;
  const height = windowHeight ?? size[1] ?? 0;

  const snapshot = runtimeManager.snapshot();
  const active = snapshot.runtimes.find((runtime) => runtime.id === snapshot.activeRuntimeId);
  const sidebarWidth = getSidebarWidth(width, shellSidebarCollapsed);
  const contentWidth = Math.max(0, width - sidebarWidth);

  for (const entry of webuiViews.values()) {
    const runtime = snapshot.runtimes.find((r) => r.id === entry.runtimeId);
    if (active?.id === entry.runtimeId && runtime?.status === 'running') {
      entry.view.setBounds({ x: sidebarWidth, y: 0, width: contentWidth, height });
      continue;
    }
    // Reaching here means a view outlived its turn as the active one, which
    // `syncActive` no longer allows — it disposes every non-active view rather
    // than parking it at zero width, because a parked view is still a live
    // Chromium renderer process. Collapsing it stays as a belt-and-braces
    // measure for the window between a runtime changing and the next sync.
    entry.view.setBounds({ x: sidebarWidth, y: 0, width: 0, height });
  }
}

/**
 * Schedule a window state save with debouncing.
 */
export function scheduleWindowStateSave(
  saveState: () => Promise<void>,
  timerRef: { current: ReturnType<typeof setTimeout> | null },
): void {
  if (timerRef.current) clearTimeout(timerRef.current);
  timerRef.current = setTimeout(() => {
    timerRef.current = null;
    void saveState();
  }, 350);
}
