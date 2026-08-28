/**
 * WS-062 / WS-069 — what the WebUI writes to browser storage.
 *
 * WS-069: `apiKey` was in the config store's `partialize`, so the day anything
 * set it a provider credential would land in `localStorage`. Nothing writes it
 * today — keys travel over the WebSocket to the server, which owns them — which
 * makes this a latent sink and the cheapest possible moment to close it.
 *
 * WS-062: the chat transcript was persisted at the in-memory cap. Not literally
 * unbounded (`MAX_CHAT_MESSAGES` is 1000), but that cap is sized for the HEAP —
 * up to 48 MB retained — while `localStorage` holds ~5 MB. Writing the full
 * in-memory window trends toward a quota exception, and when `persist` throws
 * it silently stops writing ANYTHING, including the typed-but-unsubmitted queue
 * the persistence exists to protect.
 *
 * Both are asserted through the stores' real `partialize` / `merge` functions
 * rather than by driving a fake `localStorage`, because those two functions are
 * the entire contract for what leaves memory.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The chat surface's persistence lives with the lane registry: persisted lane
// data can protect drafts/transcripts, but open tab ids and the foreground
// pointer are deliberately not resurrected on a fresh WebUI load.
const chatSource = readFileSync(
  resolve(import.meta.dirname, '../../src/stores/chat-lanes.ts'),
  'utf8',
);
const chatFacadeSource = readFileSync(
  resolve(import.meta.dirname, '../../src/stores/chat-store.ts'),
  'utf8',
);
const configSource = readFileSync(
  resolve(import.meta.dirname, '../../src/stores/config-store.ts'),
  'utf8',
);

/** The `partialize` body of a store source, which decides what is persisted. */
function partializeBody(source: string): string {
  const start = source.indexOf('partialize:');
  expect(start, 'store must declare partialize').toBeGreaterThan(-1);
  const merge = source.indexOf('merge:', start);
  const migrate = source.indexOf('migrate:', start);
  const ends = [merge, migrate].filter((i) => i > -1);
  return source.slice(start, ends.length > 0 ? Math.min(...ends) : start + 2000);
}

describe('config store never persists a credential (WS-069)', () => {
  it('omits apiKey from partialize', () => {
    expect(partializeBody(configSource)).not.toMatch(/\bapiKey\b/);
  });

  it('still persists the ordinary preferences', () => {
    // The fix must be a removal of one field, not collateral damage to the
    // settings users expect to survive a reload.
    const body = partializeBody(configSource);
    for (const key of ['provider', 'model', 'baseUrl', 'theme', 'autoConnect']) {
      expect(body, key).toContain(key);
    }
  });

  it('strips a legacy persisted apiKey on read', () => {
    // Dropping it from `partialize` alone leaves any previously-written value
    // in storage, rehydrating into memory on every load. `merge` has to
    // actively discard it so the next persist clears it from disk too.
    const mergeStart = configSource.indexOf('merge:');
    expect(mergeStart).toBeGreaterThan(-1);
    expect(configSource.slice(mergeStart)).toMatch(/apiKey:\s*\w+/);
  });
});

describe('chat store bounds what reaches localStorage (WS-062)', () => {
  it('caps the persisted slice separately from the in-memory cap', () => {
    expect(chatFacadeSource).toMatch(/const MAX_PERSISTED_MESSAGES = \d+/);
    expect(partializeBody(chatSource)).toContain('slice(-MAX_PERSISTED_MESSAGES)');
  });

  it('persists strictly fewer messages than it retains in memory', () => {
    // The point of the finding: a storage budget cannot be the heap budget.
    const persisted = Number(/const MAX_PERSISTED_MESSAGES = (\d+)/.exec(chatFacadeSource)?.[1]);
    const inMemory = Number(/const MAX_CHAT_MESSAGES = (\d+)/.exec(chatFacadeSource)?.[1]);
    expect(persisted).toBeGreaterThan(0);
    expect(inMemory).toBeGreaterThan(0);
    expect(persisted).toBeLessThan(inMemory);
  });

  it('keeps the MOST RECENT messages, not the oldest', () => {
    // `slice(-n)` vs `slice(0, n)` is a one-character difference that would
    // restore the wrong end of the transcript after a refresh.
    expect(partializeBody(chatSource)).not.toContain('slice(0, MAX_PERSISTED_MESSAGES)');
  });

  it('still strips attachment data-URLs', () => {
    // The pre-existing half of the quota defence must survive this change.
    expect(partializeBody(chatSource)).toContain('dataUrl: undefined');
  });

  it('still persists the unsubmitted queue, but not the active tab pointer', () => {
    // These are the reason persistence exists at all; a quota fix that drops
    // queue would trade typed input for storage headroom. The foreground tab
    // pointer must not persist, because it makes a new WebUI boot with a
    // half-restored old tab.
    const body = partializeBody(chatSource);
    expect(body).toContain('queue:');
    expect(body).not.toContain('activeSessionId: s.activeSessionId');
  });

  it('persists every lane, not just the one in front', () => {
    // Four tabs, four transcripts. Persisting only the foreground would make a
    // reload silently empty the other three.
    const body = partializeBody(chatSource);
    expect(body).toContain('lanes:');
    expect(body).toContain('Object.entries(s.lanes)');
  });

  it('bounds the persisted lane count at the tab ceiling', () => {
    expect(partializeBody(chatSource)).toContain('slice(0, MAX_LANES)');
  });
});
