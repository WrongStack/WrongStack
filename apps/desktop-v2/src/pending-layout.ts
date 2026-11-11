interface PendingLayout {
  token: string;
  value: string;
}
const cacheKey = (key: string) => `wrongstack.desktop.pending-layout:${key}`;

function pendingLayout(key: string): PendingLayout | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(key));
    const pending = raw ? JSON.parse(raw) : null;
    if (typeof pending?.token !== 'string' || typeof pending?.value !== 'string') return null;
    const layout: unknown = JSON.parse(pending.value);
    return layout && typeof layout === 'object' && !Array.isArray(layout) ? pending : null;
  } catch {
    return null;
  }
}

/** Only unacknowledged state from this window may take precedence over the host. */
export const pendingLayoutValue = (key: string): string | null => pendingLayout(key)?.value ?? null;

export function stagePendingLayout(key: string, value: string): string {
  const token = crypto.randomUUID();
  try {
    sessionStorage.setItem(cacheKey(key), JSON.stringify({ token, value }));
  } catch {
    // Native persistence still works if the webview refuses session storage.
  }
  return token;
}

export function acknowledgePendingLayout(key: string, token: string): void {
  try {
    if (pendingLayout(key)?.token === token) sessionStorage.removeItem(cacheKey(key));
  } catch {
    // A denied cache cannot prevent an acknowledged native save.
  }
}
