import { execSync, spawn } from 'node:child_process';
import * as path from 'node:path';
import {
  expect,
  test,
  type Page,
  type WebSocket as PlaywrightWebSocket,
} from '@playwright/test';
// Repo-root specs cannot import workspace packages by name (the root
// package.json does not depend on them) — import the built dist directly.
import { DefaultSessionStore } from '../packages/core/dist/storage/index.js';
import { resolveWstackPaths } from '../packages/core/dist/utils/index.js';

/** Minimal local stand-ins for the core journal types (erased at transpile). */
type SeededEvent = { type: 'user_input'; ts: string; content: string };
type ClosableWriter = {
  append: (event: SeededEvent) => Promise<unknown>;
  close?: () => Promise<unknown>;
};
type SeededStore = {
  create: (meta: {
    id: string;
    title: string;
    provider: string;
    model: string;
  }) => Promise<ClosableWriter>;
  delete: (id: string) => Promise<unknown>;
  dispose?: () => Promise<unknown>;
};

/**
 * The four-tab no-mixing proof — the last missing piece of the session
 * isolation guarantee.
 *
 * Four sessions, each seeded with uniquely-tagged transcript messages, are
 * opened as four WebUI session tabs in ONE browser page — which means ONE
 * WebSocket socket carries all four sessions' replay streams interleaved
 * with every other frame. For every tab we then assert:
 *
 *   - every OWN marker is rendered in the transcript (positive), and
 *   - EVERY other session's markers appear NOWHERE in the DOM
 *     (4 tabs × 3 foreigners × 8 markers = 96 negative assertions — the
 *     all-pairs matrix).
 *
 * Plus structural evidence captured from the wire: exactly one socket for
 * all four tabs, and replay frames for all four sessions observed on it.
 *
 * Streams without an LLM: each tab's opening `session.resume` triggers a
 * server-side replay burst of that session's journal (up to the replay cap)
 * — session-tagged frames delivered over the shared socket while the other
 * tabs' UI traffic flows. Seeding goes through `DefaultSessionStore.create`
 * + writer appends (NOT raw file drops: the store's list() is index-driven
 * with tombstone semantics, and only `create()` writes the durable
 * `{action:'create'}` row that makes a session discoverable).
 *
 * Requires the STANDALONE multi-session server (`webui-server` entry), same
 * as e2e/worklist-per-session.spec.ts — the spec restarts it itself so the
 * freshly seeded sessions are listed with a cold agent registry. Skipped
 * unless WEBUI_URL + WEBUI_E2E_TOKEN point at it.
 */

const NAMES = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA'] as const;
type Name = (typeof NAMES)[number];

const MARKER_COUNT = 8;
const marker = (name: Name, i: number): string =>
  `E2E4T-${name}-${String(i + 1).padStart(2, '0')}`;
const sessionIdFor = (name: Name): string => `sess_e2e4t_${name.toLowerCase()}`;
const titleFor = (name: Name): string => `E2E4T ${name}`;

interface ListedSession {
  id: string;
  title?: string | undefined;
  tokenTotal?: number | undefined;
  isCurrent?: boolean | undefined;
}

/**
 * Reload and capture the `sessions.list` frame the client receives on
 * connect — the server's own view of the store, independent of the panel UI.
 */
async function captureSessionsList(page: Page): Promise<ListedSession[]> {
  let captured: ListedSession[] | undefined;
  page.on('websocket', (ws) => {
    ws.on('framereceived', (frame) => {
      if (captured) return;
      try {
        const msg = JSON.parse(String(frame.payload ?? '{}')) as {
          type?: string;
          payload?: { sessions?: ListedSession[] };
        };
        if (msg.type === 'sessions.list' && Array.isArray(msg.payload?.sessions)) {
          captured = msg.payload.sessions;
        }
      } catch {
        // non-JSON frame
      }
    });
  });
  await page.reload();
  await page.locator('textarea').first().waitFor({ timeout: 20_000 });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !captured) {
    await page.waitForTimeout(500);
  }
  if (!captured) throw new Error('sessions.list never arrived after reload');
  return captured;
}

// ── Seeding ────────────────────────────────────────────────────────────────

/**
 * The standalone server resolves its session store via
 * `wpaths.projectSessions` — `~/.wrongstack/projects/<slug>/sessions`, NOT
 * the repo-local `.wrongstack/sessions`. Seeding must target the exact same
 * dir, derived the same way through the same resolver, or the server's
 * sessions.list never sees the fixtures.
 */
function e2eStore(): SeededStore {
  const projectRoot = process.cwd();
  const paths = resolveWstackPaths({ projectRoot });
  return new DefaultSessionStore({
    dir: paths.projectSessions,
    projectRoot,
  }) as unknown as SeededStore;
}

async function seedFourSessions(): Promise<void> {
  const store = e2eStore();
  try {
    for (const name of NAMES) {
      // create() truncates any prior fixture under the same id and writes
      // the durable create-row, so re-runs are idempotent.
      const writer = await store.create({
        id: sessionIdFor(name),
        title: titleFor(name),
        provider: 'e2e',
        model: 'e2e',
      });
      for (let i = 0; i < MARKER_COUNT; i++) {
        const event: SeededEvent = {
          type: 'user_input',
          ts: new Date(Date.now() - (MARKER_COUNT - i) * 60_000).toISOString(),
          // The History entry title is the first prompt truncated at ~50
          // chars (measured from the panel dump). Two constraints:
          //  - the SESSION NAME must sit inside that prefix, or the four
          //    entries become indistinguishable and unclickable;
          //  - every marker must sit far BEYOND it, or every tab's sidebar
          //    carries every other session's markers and the all-pairs DOM
          //    negatives become unprovable.
          content: `E2E4T ${name} fixture ${i + 1}/${MARKER_COUNT}. Padding so the unique stream marker sits beyond the History title truncation: ${marker(name, i)}`,
        };
        await writer.append(event);
      }
      // close() flushes the summary sidecar the History list titles come from.
      await writer.close?.();
    }
  } finally {
    await store.dispose?.();
  }
}

async function deleteFourSessionsBestEffort(): Promise<void> {
  const store = e2eStore();
  try {
    for (const name of NAMES) {
      try {
        await store.delete(sessionIdFor(name));
      } catch (err) {
        // The running server may still hold the session live — best effort.
        console.log(`[four-tab-e2e] cleanup skipped for ${name}: ${String(err)}`);
      }
    }
  } finally {
    await store.dispose?.();
  }
}

// ── Standalone server restart (verbatim strategy from worklist spec) ───────

function pidsListeningOn(port: string): number[] {
  const out = execSync('netstat -ano', { encoding: 'utf8', windowsHide: true });
  const pids = new Set<number>();
  for (const line of out.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const local = parts[1] ?? '';
    const state = parts[3] ?? '';
    const pid = Number(parts[4]);
    if (state !== 'LISTENING' || !local.endsWith(`:${port}`)) continue;
    if (Number.isInteger(pid) && pid > 0) pids.add(pid);
  }
  return [...pids];
}

async function restartStandaloneServer(baseURL: string, token: string): Promise<void> {
  const cwd = process.cwd();
  const url = new URL(baseURL);
  const host = url.hostname;
  const port = url.port || '3456';

  for (const pid of pidsListeningOn(port)) {
    try {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore', windowsHide: true });
    } catch {
      // already gone
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1_000));

  const child = spawn(process.execPath, ['packages/webui-server/dist/server/entry.js'], {
    cwd,
    env: {
      ...process.env,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? 'placeholder',
      NO_COLOR: '1',
      WEBUI_HOST: host,
      WEBUI_PORT: port,
      WEBUI_TOKEN: token,
      WEBUI_DIST_DIR: path.join(cwd, 'packages', 'webui', 'dist'),
    },
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  child.unref();

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${baseURL}/ws-auth?token=${encodeURIComponent(token)}`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('standalone server did not come back within 60s after restart');
}

// ── Tab strip helpers (from worklist spec) ─────────────────────────────────

async function tabTitles(page: Page): Promise<string[]> {
  return page
    .getByRole('tablist', { name: 'Open session tabs' })
    .getByRole('tab')
    .evaluateAll((els) => els.map((el) => el.getAttribute('title') ?? ''));
}

function sessionFromTitle(title: string): string | undefined {
  return title.split('\n')[2]?.trim() || undefined;
}

async function openTabIds(page: Page): Promise<string[]> {
  const ids = (await tabTitles(page)).map(sessionFromTitle).filter(Boolean) as string[];
  return ids;
}

async function switchToSession(page: Page, sessionId: string): Promise<void> {
  const titles = await tabTitles(page);
  const slot = titles.findIndex((t) => sessionFromTitle(t) === sessionId);
  if (slot === -1) {
    throw new Error(`no tab holds session ${sessionId}; strip holds: ${titles.join(' | ')}`);
  }
  const tab = page.getByRole('tablist', { name: 'Open session tabs' }).getByRole('tab').nth(slot);
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 });
}

async function closeTabsNotIn(page: Page, keep: string[]): Promise<void> {
  const tabs = page.getByRole('tablist', { name: 'Open session tabs' }).getByRole('tab');
  for (let slot = (await tabTitles(page)).length - 1; slot >= 0; slot--) {
    const titles = await tabTitles(page);
    if (titles.length <= 1) break;
    const id = sessionFromTitle(titles[slot] ?? '');
    if (!id || keep.includes(id)) continue;
    const tab = tabs.nth(slot);
    await tab.hover();
    await tab.getByTitle('Close tab').click();
    await page.waitForTimeout(300);
  }
}

/**
 * Open one fixture session from the History list, retrying until its tab is
 * in the strip. A single click is not enough: every open is a full
 * session.resume whose replay settles behind the server's serialized
 * session-transition gate, and the History list re-renders (recency sort)
 * after each open — the worklist spec's reopen loop solves the same problem
 * the same way. Clicking an already-open session is idempotent ('switched').
 */
async function openFixtureTab(page: Page, name: Name): Promise<void> {
  const want = sessionIdFor(name);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if ((await openTabIds(page)).includes(want)) return;
    const entry = page
      .getByRole('dialog', { name: 'Side panel' })
      .getByRole('button', { name: new RegExp(`E2E4T ${name} fixture`) })
      .first();
    await entry.click({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
  }
  throw new Error(
    `fixture tab for ${name} never opened; strip holds: ${(await openTabIds(page)).join(', ')}`,
  );
}

// ── The proof ──────────────────────────────────────────────────────────────

test.describe('four-tab no-mixing', () => {
  // The transcript virtualizes: only messages near the viewport stay mounted
  // (run 10's DOM scan showed exactly the newest 3 of 8 at 720px). A tall
  // viewport mounts all eight fixture bubbles so every own-marker assertion
  // is checkable without coupling the spec to the virtualizer's window.
  test.use({ viewport: { width: 1280, height: 2400 } });

  test.skip(
    !process.env.WEBUI_URL || !process.env.WEBUI_E2E_TOKEN,
    'needs the standalone multi-session server: WEBUI_URL + WEBUI_E2E_TOKEN',
  );

  test('four tabs on one socket render only their own uniquely-tagged streams', async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(420_000);
    const token = process.env.WEBUI_E2E_TOKEN as string;

    // ── Wire capture: register BEFORE any navigation so the first socket,
    // and every replay frame on it, is recorded.
    const sockets: PlaywrightWebSocket[] = [];
    const replayFrames: Array<{
      socket: PlaywrightWebSocket;
      sessionId: string;
      messages: number;
    }> = [];
    const frameTypeCounts = new Map<string, number>();
    page.on('websocket', (ws) => {
      sockets.push(ws);
      ws.on('framereceived', (frame) => {
        try {
          const msg = JSON.parse(String(frame.payload ?? '{}')) as {
            type?: string;
            payload?: { sessionId?: string; replayMessages?: unknown[] };
          };
          if (msg.type) {
            frameTypeCounts.set(msg.type, (frameTypeCounts.get(msg.type) ?? 0) + 1);
          }
          if (Array.isArray(msg.payload?.replayMessages) && msg.payload?.sessionId) {
            replayFrames.push({
              socket: ws,
              sessionId: msg.payload.sessionId,
              messages: (msg.payload.replayMessages as unknown[]).length,
            });
          }
        } catch {
          // non-JSON frame
        }
      });
    });

    // ── Seed + cold server: the fixture sessions must come from the store ──
    await seedFourSessions();
    await restartStandaloneServer(baseURL as string, token);

    await page.goto(`${baseURL}/?token=${encodeURIComponent(token)}`);
    await page.locator('textarea').first().waitFor({ timeout: 20_000 });

    // ── Self-diagnosis: what does the SERVER list vs. what the panel shows ──
    const listed = await captureSessionsList(page);
    console.log(
      JSON.stringify({
        event: 'e2e4t.sessions_list',
        total: listed.length,
        fixtures: NAMES.map((name) => ({
          name,
          id: sessionIdFor(name),
          present: listed.some((s) => s.id.includes(sessionIdFor(name))),
        })),
        head: listed.slice(0, 8).map((s) => ({ id: s.id, title: s.title, tok: s.tokenTotal })),
      }),
    );
    const diagPanel = page.getByRole('dialog', { name: 'Side panel' });
    const panelText = await diagPanel.innerText({ timeout: 10_000 }).catch(() => 'PANEL_TEXT_ERR');
    console.log(
      JSON.stringify({
        event: 'e2e4t.panel_dump',
        buttons: await diagPanel.getByRole('button').count(),
        textHead: panelText.slice(0, 800),
      }),
    );

    // ── Open all four from History (by unique title) into the tab strip ──
    const panel = page.getByRole('dialog', { name: 'Side panel' });
    for (const name of NAMES) {
      await openFixtureTab(page, name);
      // After the FIRST fixture opens, evict the boot session's tab: the
      // four-slot ceiling is otherwise already full (boot + 3 fixtures) when
      // the last fixture opens, and nothing guarantees the boot tab is
      // disposable — DELTA simply never gets a slot.
      if (name === NAMES[0]) {
        await closeTabsNotIn(page, NAMES.map(sessionIdFor));
      }
    }

    // Enforce exactly the four fixture tabs (a leftover disposable tab from
    // the fresh boot may or may not have been recycled).
    await closeTabsNotIn(page, NAMES.map(sessionIdFor));
    const stripIds = await openTabIds(page);
    expect(new Set(stripIds).size, 'exactly the four fixture tabs').toBe(4);
    for (const name of NAMES) {
      expect(stripIds).toContain(sessionIdFor(name));
    }

    // ── Wire evidence: every session's replay arrived over ONE SAME socket ──
    // Total socket COUNT is a brittle proxy — auxiliary control connections
    // are legitimate. The property that matters: all four sessions' streams
    // demultiplexed over a single shared connection, and that connection is
    // still live at proof time.
    const replaySockets = new Set(replayFrames.map((f) => f.socket));
    expect(replaySockets.size, 'all four sessions replayed over one shared socket').toBe(1);
    const sharedSocket = [...replaySockets][0];
    expect(Boolean(sharedSocket && !sharedSocket.isClosed()), 'shared socket is live').toBe(true);
    const replayedSessions = new Set(replayFrames.map((f) => f.sessionId));
    for (const name of NAMES) {
      expect(replayedSessions, `replay observed for ${name}`).toContain(sessionIdFor(name));
    }
    // Interleave evidence (logged, not asserted — ordering is not contractual):
    const order = replayFrames.map((f) => f.sessionId);
    const selfContained = NAMES.every((name) => {
      const idx = order
        .map((sid, i) => (sid === sessionIdFor(name) ? i : -1))
        .filter((i) => i >= 0);
      if (idx.length < 2) return true;
      return idx.slice(1, -1).every((i) => order[i] === sessionIdFor(name));
    });
    console.log(
      JSON.stringify({
        event: 'e2e4t.wire_evidence',
        sockets: sockets.length,
        replayFrames: replayFrames.length,
        replayOrder: order,
        replayFramesStrictlyContiguousPerSession: selfContained,
        frameTypeCounts: Object.fromEntries(frameTypeCounts),
      }),
    );

    // ── The all-pairs matrix: for each tab, own markers present, every
    // foreign marker absent from the ENTIRE DOM ──
    let domScanned = false;
    for (const selfName of NAMES) {
      await switchToSession(page, sessionIdFor(selfName));
      if (!domScanned) {
        // One-shot DOM truth: what did the transcript actually render?
        domScanned = true;
        const bodyText = await page.evaluate(() => document.body.innerText);
        console.log(
          JSON.stringify({
            event: 'e2e4t.dom_scan',
            e2e4tLines: bodyText.split('\n').filter((l) => l.includes('E2E4T')).slice(0, 40),
          }),
        );
      }
      for (let i = 0; i < MARKER_COUNT; i++) {
        await expect(page.getByText(marker(selfName, i))).toBeVisible({ timeout: 20_000 });
      }
      for (const otherName of NAMES) {
        if (otherName === selfName) continue;
        for (let i = 0; i < MARKER_COUNT; i++) {
          await expect(page.getByText(marker(otherName, i))).toHaveCount(0);
        }
      }
    }

    // ── Round trip: the matrix survives a full switching cycle ──
    await switchToSession(page, sessionIdFor('ALPHA'));
    await expect(page.getByText(marker('ALPHA', 1))).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(marker('DELTA', 1))).toHaveCount(0);
    await expect(page.getByText(marker('CHARLIE', 8))).toHaveCount(0);
  });

  test.afterAll(async () => {
    // The fixture sessions are clearly-named test artifacts in the real
    // project session store; remove them when nothing holds them live.
    if (process.env.WEBUI_URL && process.env.WEBUI_E2E_TOKEN) {
      // Sessions whose tabs the test left open stay live in the server's
      // agent registry and refuse deletion (SessionOwnershipConflictError).
      // A restart drops the live agents so the deletes go through.
      await restartStandaloneServer(
        process.env.WEBUI_URL,
        process.env.WEBUI_E2E_TOKEN,
      ).catch(() => {});
      await deleteFourSessionsBestEffort();
    }
  });
});
