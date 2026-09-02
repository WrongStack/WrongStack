import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every `hq.*` frame the server sends to a BROWSER must be a frame the browser
 * knows how to receive.
 *
 * `hq.kanban_snapshot` was defined in `core/src/hq/protocol/kanban.ts`, sent to
 * every browser socket by `hq-server/ws.ts` — unscoped, one chunk per board
 * delta — and appeared nowhere in `HqBrowserMessage` or in the SPA's dispatch
 * chain. `HqWsClient` parsed each frame, handed it to the handler, and it fell
 * off the end. Every browser paid the bandwidth and the GC for every project's
 * board deltas and then discarded them, which is also why the Kanban view
 * refetches the whole board over HTTP: the delta it already holds is unusable.
 *
 * `webui` has this parity guard for `WSClientMessage`. HQ did not, which is why
 * the drift lasted.
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * `type: 'hq.x'` literals the server emits.
 *
 * Scans both the `hq-server/` modules and `hq-server.ts` itself — the browser
 * heartbeat lives in the latter, so scanning only the directory would report
 * its ignore-list entry as stale.
 */
function serverSentTypes(): Set<string> {
  const dir = path.join(ROOT, 'cli/src/hq-server');
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(dir, f));
  files.push(path.join(ROOT, 'cli/src/hq-server.ts'));
  const found = new Set<string>();
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const m of source.matchAll(/type:\s*'(hq\.[a-z_]+)'/g)) {
      if (m[1]) found.add(m[1]);
    }
  }
  return found;
}

/**
 * Frame types the browser SPA actually branches on.
 *
 * The dispatch lives in `webui-hq/src/data/wire.ts` (`applySocketMessage`) as a
 * `switch` over `message.type` — it moved out of `main.tsx`, which is now only
 * boot wiring.
 */
function browserHandledTypes(): Set<string> {
  const source = read('webui-hq/src/data/wire.ts');
  const found = new Set<string>();
  for (const m of source.matchAll(/case\s*'(hq\.[a-z_]+)':/g)) {
    if (m[1]) found.add(m[1]);
  }
  return found;
}

/**
 * Frame types reachable through the `HqBrowserMessage` union.
 *
 * The union imports several members (resume, alert, heartbeat) from sibling
 * protocol modules, so scanning `browser.ts` alone under-reports it — collect
 * the literals across the whole protocol directory.
 */
function unionTypes(): Set<string> {
  const dir = path.join(ROOT, 'core/src/hq/protocol');
  const found = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.ts')) continue;
    const source = readFileSync(path.join(dir, file), 'utf8');
    for (const m of source.matchAll(/type:\s*'(hq\.[a-z_]+)'/g)) {
      if (m[1]) found.add(m[1]);
    }
  }
  return found;
}

/**
 * Frames the server sends to browsers that the SPA deliberately ignores.
 * Each needs a stated reason — an entry here is a decision, not a gap.
 */
const BROWSER_IGNORED: Record<string, string> = {
  // Client-plane frames: sent on /ws/client to a publishing CLI/TUI, never to
  // a browser socket.
  'hq.command_batch': 'client-plane only — delivered to publishers, not browsers',
  'hq.welcome': 'client-plane handshake ack on /ws/client',
  // Consumed by the transport (HqSocket) as liveness rather than by the
  // dispatch switch, so it has no `case` in wire.ts.
  'hq.heartbeat': 'transport keepalive, handled by HqSocket',
  // Client-plane only as of this audit: the browser fan-out was removed
  // because nothing consumed it (see fanoutKanbanDelta). Sent at client hello
  // and after each merge, to publishing CLI/TUI peers.
  'hq.kanban_snapshot': 'client-plane only — no browser consumer, fan-out removed',
};

describe('HQ browser protocol parity', () => {
  it('every browser-bound frame is either handled or explicitly ignored', () => {
    const handled = browserHandledTypes();
    const unhandled = [...serverSentTypes()].filter(
      (t) => !handled.has(t) && !(t in BROWSER_IGNORED),
    );
    expect(
      unhandled,
      `hq-server/ws.ts sends these to browsers but webui-hq/src/data/wire.ts has no case ` +
        `for them: ${unhandled.join(', ')}. Add a branch, or add an entry to ` +
        `BROWSER_IGNORED explaining why the browser drops it.`,
    ).toEqual([]);
  });

  it('every frame the SPA handles is in the HqBrowserMessage union', () => {
    const union = unionTypes();
    const missing = [...browserHandledTypes()].filter((t) => !union.has(t));
    expect(
      missing,
      `wire.ts branches on these but HqBrowserMessage does not declare them: ` +
        `${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('the ignore-list has no stale entries', () => {
    const sent = serverSentTypes();
    const stale = Object.keys(BROWSER_IGNORED).filter((t) => !sent.has(t));
    expect(stale, `no longer sent — drop from BROWSER_IGNORED: ${stale.join(', ')}`).toEqual([]);
  });
});
