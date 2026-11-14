/**
 * Desktop update notice: what the native check reported (`update_check`) and the user's own
 * choices about it. The choices stay in this machine's webview storage, not in the shared
 * registry: a session host from an older build serves that registry after every update and
 * refuses setting keys it does not know.
 */

/** What `update_check` answers (`src-tauri/src/update.rs`). */
export interface UpdateStatus {
  current: string;
  /** The newer version, when there is one. */
  version?: string | null;
  /** Where the release is described and can be downloaded. */
  releaseUrl: string;
  /** Whether this build downloads and installs the release itself (Windows, macOS). */
  canInstall: boolean;
}

export interface UpdatePrefs {
  /** Check at launch and every {@link CHECK_INTERVAL_MS}. On unless turned off. */
  enabled: boolean;
  /** A version the user put off with "Later": it is not offered again. */
  dismissed?: string;
}

export interface UpdateNotice {
  version: string;
  releaseUrl: string;
  canInstall: boolean;
}

export const UPDATE_PREFS_KEY = 'wrongstack.desktop.updates';
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

type Reader = Pick<Storage, 'getItem'>;
type Writer = Pick<Storage, 'setItem'>;

/** The saved choices; anything unreadable is the default (checks on, nothing put off). */
export function readUpdatePrefs(storage: Reader | undefined): UpdatePrefs {
  try {
    const raw = storage?.getItem(UPDATE_PREFS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;
    if (!parsed || typeof parsed !== 'object') return { enabled: true };
    const value = parsed as Record<string, unknown>;
    return {
      enabled: value.enabled !== false,
      ...(typeof value.dismissed === 'string' ? { dismissed: value.dismissed } : {}),
    };
  } catch {
    return { enabled: true };
  }
}

const listeners = new Set<(prefs: UpdatePrefs) => void>();

/** Saves the choices and tells every reader in this window. Storage failures only lose them. */
export function writeUpdatePrefs(storage: Writer | undefined, prefs: UpdatePrefs): void {
  try {
    storage?.setItem(UPDATE_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Private or full storage: the choice lasts until the window closes.
  }
  for (const listener of listeners) listener(prefs);
}

export function subscribeUpdatePrefs(listener: (prefs: UpdatePrefs) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The notice to show for a check, or null when there is nothing newer or it was put off. */
export function noticeFor(
  status: UpdateStatus | undefined,
  prefs: UpdatePrefs,
): UpdateNotice | null {
  const version = status?.version?.trim();
  if (!status || !version || !prefs.enabled || prefs.dismissed === version) return null;
  return { version, releaseUrl: status.releaseUrl, canInstall: status.canInstall };
}
