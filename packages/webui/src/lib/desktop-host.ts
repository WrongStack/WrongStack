import { useLocalPrefs } from '@/stores/local-prefs';

/**
 * Desktop-shell bridge.
 *
 * Electron hosts the real WebUI in a `WebContentsView` and exposes a handful of
 * `window.wrongstackDesktopHost` / `window.wrongstackDesktopCommands` bridge
 * hooks. These helpers are the WebUI → native side of that bridge: publishing
 * readiness, mirroring the local prefs the native menu needs, and acking the
 * commands the native sidebar dispatches. Browser users never see any of this
 * (every helper no-ops when the bridge object is absent), so it lives out of
 * `App.tsx` to keep the app shell from absorbing desktop/bridge logic.
 */

/** `currentView` values the native sidebar may switch to via a desktop command. */
export const DESKTOP_COMMAND_VIEWS = new Set([
  'chat',
  'settings',
  'goal',
  'kanban',
  'sddhub',
  'files',
  'changes',
  'sessions',
  'setup',
  'skill',
  'roster',
  'mailbox',
  'debug',
  'design-gallery',
  'refresh-debug',
  'analytics',
]);

/** WorkspaceDock sections the native sidebar may reveal via a desktop command. */
export const DESKTOP_COMMAND_DOCKS = new Set(['goal', 'fleet', 'work', 'worktrees', 'collab']);

/** Work-dashboard tabs the native sidebar may focus via a desktop command. */
export const DESKTOP_COMMAND_WORK_TABS = new Set(['todos', 'tasks', 'plan']);

/** Push the current local prefs snapshot to the native host (for menu state). */
export function publishDesktopPrefsSnapshot(): void {
  if (typeof window === 'undefined') return;
  const host = (
    window as unknown as {
      wrongstackDesktopHost?: {
        setReady?: (ready: boolean) => void;
        setPrefs?: (prefs: {
          yolo: boolean;
          nextPrediction: boolean;
          contextAutoCompact: boolean;
        }) => void;
        ackCommand?: (requestId: string, handled: boolean, message?: string | undefined) => void;
      };
    }
  ).wrongstackDesktopHost;
  if (!host?.setPrefs) return;
  const prefs = useLocalPrefs.getState();
  host.setPrefs({
    yolo: prefs.yolo,
    nextPrediction: prefs.nextPrediction,
    contextAutoCompact: prefs.contextAutoCompact,
  });
}

/** Tell the native host whether the WebUI is mounted and ready for commands. */
export function publishDesktopReady(ready: boolean): void {
  if (typeof window === 'undefined') return;
  const host = (
    window as unknown as {
      wrongstackDesktopHost?: {
        setReady?: (ready: boolean) => void;
      };
    }
  ).wrongstackDesktopHost;
  host?.setReady?.(ready);
}

/** Ack a dispatched desktop command back to the native host by request id. */
export function publishDesktopCommandAck(
  requestId: unknown,
  handled: boolean,
  message?: string | undefined,
): void {
  if (typeof window === 'undefined' || typeof requestId !== 'string') return;
  const host = (
    window as unknown as {
      wrongstackDesktopHost?: {
        ackCommand?: (id: string, handled: boolean, message?: string | undefined) => void;
      };
    }
  ).wrongstackDesktopHost;
  host?.ackCommand?.(requestId, handled, message);
}
