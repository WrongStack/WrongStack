import { SESSION_SCOPED_PREF_KEYS } from '@wrongstack/webui-server/server/session-scoped-prefs.js';
import { describe, expect, it } from 'vitest';
import { SESSION_SCOPED_PREFS } from '@/stores/local-prefs';

/**
 * The two halves of "this preference belongs to ONE tab".
 *
 * `SESSION_SCOPED_PREFS` (browser) decides which keys the pref store parks in
 * its `bySession` map and reads back through `sessionPref()`.
 * `SESSION_SCOPED_PREF_KEYS` (server) decides which keys `handlePrefsUpdate`
 * writes to the calling session's `ctx.meta` instead of the process-wide meta,
 * and which half of the `prefs.updated` echo carries a `sessionId`.
 *
 * They were kept in step by hand, with a comment on each asking the next
 * person to remember. Drift is silent and asymmetric, and both directions are
 * bugs a user actually sees:
 *
 *   - a key the SERVER scopes but the client does not: the value is stored per
 *     session but every picker reads the flat field, so the panel shows the
 *     tab in front while the write lands on the tab that asked;
 *   - a key the CLIENT scopes but the server does not: the browser shows four
 *     independent values over ONE shared runtime setting, so switching tabs
 *     appears to change a setting that never actually moved.
 *
 * This test is the enforcement those comments asked for.
 */
describe('session-scoped preference keys — client ↔ server parity', () => {
  it('declares exactly the same key set on both sides', () => {
    const client = [...SESSION_SCOPED_PREFS].sort();
    const server = [...SESSION_SCOPED_PREF_KEYS].sort();
    expect(client).toEqual(server);
  });

  it('lists every key exactly once on each side', () => {
    expect(new Set(SESSION_SCOPED_PREFS).size).toBe(SESSION_SCOPED_PREFS.length);
    expect(SESSION_SCOPED_PREF_KEYS.size).toBe([...SESSION_SCOPED_PREF_KEYS].length);
  });

  /**
   * The keys that make a tab a tab. Losing any of these from the scoped set is
   * not a drift between two lists — it is a preference silently going global,
   * and `yolo` going global means one tab's auto-approval answering another
   * tab's permission prompt.
   */
  it('keeps the load-bearing keys scoped', () => {
    for (const key of ['yolo', 'autonomy', 'maxIterations', 'systemPromptVariant'] as const) {
      expect(SESSION_SCOPED_PREFS).toContain(key);
      expect(SESSION_SCOPED_PREF_KEYS.has(key)).toBe(true);
    }
  });
});
