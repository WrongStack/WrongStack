/**
 * Time / id formatting helpers shared by both mailbox views.
 *
 * The formatting rules here are deliberately simple — the TUI uses
 * a different locale than the WebUI does, and a UI change here
 * affects every message row in both views, so we keep the contract
 * small and explicit.
 */

const MS_PER_SECOND = 1000;

/**
 * Render an ISO 8601 timestamp as a localised string. Falls back to
 * the raw string on parse failure (which keeps the UI usable even
 * when a client sends a malformed timestamp).
 */
export function formatMailboxTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString();
}

/**
 * Return a compact, human-readable version of the elapsed time since
 * `ts`, suitable for "5m ago" / "2h ago" placeholders. Returns the
 * full timestamp string if the input is unparseable.
 *
 * Buckets (seconds → minutes → hours → days → weeks → months → years)
 * trade absolute precision for readability on a small status-bar chip.
 */
export function formatRelativeTime(ts: string, now: number = Date.now()): string {
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return ts;
  const diff = Math.max(0, now - t) / MS_PER_SECOND;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 60 * 60) return `${Math.round(diff / 60)}m ago`;
  if (diff < 60 * 60 * 24) return `${Math.round(diff / 3600)}h ago`;
  if (diff < 60 * 60 * 24 * 7) return `${Math.round(diff / 86400)}d ago`;
  if (diff < 60 * 60 * 24 * 30) return `${Math.round(diff / 604800)}w ago`;
  if (diff < 60 * 60 * 24 * 365) return `${Math.round(diff / 2592000)}mo ago`;
  return `${Math.round(diff / 31536000)}y ago`;
}

/**
 * Truncate a long id/UUID to a 14-char "xxxxxxxx…xxxx" form for
 * display. Identifiers shorter than or equal to 14 chars are returned
 * verbatim — the ellipsis would only add noise.
 */
export function shortMailboxId(s: string): string {
  if (s.length <= 14) return s;
  return `${s.slice(0, 8)}…${s.slice(-4)}`;
}
