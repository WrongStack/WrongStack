import { execSync, spawn } from 'node:child_process';
import type { Server } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
// Use workspace package exports so the spec does not depend on untracked dist files.
import { DefaultSessionStore } from '@wrongstack/core/storage';
import { resolveWstackPaths } from '@wrongstack/core/utils';

/**
 * The four-tab LIVE-RUNS proof — the runtime counterpart of
 * `four-tab-no-mixing.spec.ts` (which proves replay isolation). Here four
 * sessions each START A REAL RUN (agent → LLM → streamed reply → usage
 * accounting) while all four tabs sit on ONE page over ONE WebSocket:
 *
 *   1. a local OpenAI-compatible stub provider is registered via
 *      `provider.add` (family `openai-compatible`, baseUrl → this spec's
 *      own HTTP server), so runs complete without any real API key;
 *   2. four seeded sessions (one stub model each) are opened as four tabs;
 *   3. a marker prompt is typed and sent in each tab WITHOUT waiting for
 *      the previous run to finish — the stub delays every completion 4s,
 *      so all four runs are provably in flight at once (every run.result
 *      frame lands after the last send);
 *   4. the isolation matrix: per tab — own transcript markers visible,
 *      every foreign marker absent from the whole DOM, the header's
 *      provider/model chip shows THIS session's model only, and the tab
 *      strip shows THIS session's token total (stub usage is per-model:
 *      1.1k / 2.2k / 3.3k / 4.4k — four distinct counters);
 *   5. a second switch cycle re-asserts persistence (nothing was parked,
 *      lost, or swapped by the round trip).
 *
 * Requires the STANDALONE multi-session server, same as
 * e2e/four-tab-no-mixing.spec.ts — the spec restarts it itself so the
 * freshly seeded sessions are listed with a cold agent registry. Skipped
 * unless WEBUI_URL + WEBUI_E2E_TOKEN point at it.
 */

const NAMES = ['ALPHA', 'BRAVO', 'CHARLIE', 'DELTA'] as const;
type Name = (typeof NAMES)[number];

const PROVIDER_ID = 'e2e-lr-stub';
const modelFor = (name: Name): string => `e2elr-${name.toLowerCase()}`;
const sessionIdFor = (name: Name): string => `sess_e2elr_${name.toLowerCase()}`;

/** Seed-marker count per session (keep replay light; the run adds the rest). */
const SEED_COUNT = 2;
const seedMarker = (name: Name): string => `E2ELR-SEED-${name}`;
/** The run prompt's unique marker — sits >60 chars in, past any title cut. */
const runMarker = (name: Name): string => `E2ELR-RUN-${name}`;
const replyMarker = (name: Name): string => `E2ELR-REPLY-${name}`;

/** Per-model stub usage → four distinct token totals on the tab strip. */
const PROMPT_TOKENS: Record<Name, number> = {
  ALPHA: 1000,
  BRAVO: 2000,
  CHARLIE: 3000,
  DELTA: 4000,
};
const COMPLETION_TOKENS: Record<Name, number> = {
  ALPHA: 111,
  BRAVO: 222,
  CHARLIE: 333,
  DELTA: 444,
};
/** formatTokens(1111..4444) → '1.1k'..'4.4k' (SessionTabBar/summaries.ts). */
const TOK_LABEL: Record<Name, string> = {
  ALPHA: '1.1k tok',
  BRAVO: '2.2k tok',
  CHARLIE: '3.3k tok',
  DELTA: '4.4k tok',
};

const RUN_PROMPT = (name: Name): string =>
  `Run task for session ${name}: please echo the exact marker token ${runMarker(
    name,
  )} back to me and confirm the model in use.`;

/** ms the stub waits before streaming — keeps all four runs in flight at once. */
const STUB_DELAY_MS = 4_000;

// ── Stub provider (OpenAI-compatible, on an ephemeral loopback port) ───────

interface StubHandle {
  server: Server;
  port: number;
  close: () => Promise<void>;
  /** chat/completions requests seen, in order (for wire-evidence logging). */
  requests: Array<{ model: string; at: number }>;
}

async function startStubProvider(): Promise<StubHandle> {
  const requests: StubHandle['requests'] = [];
  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: NAMES.map((n) => ({ id: modelFor(n), object: 'model' })),
        }),
      );
      return;
    }
    if (req.method === 'POST' && url.endsWith('/chat/completions')) {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        let body: { model?: string; messages?: Array<{ content?: unknown }> } = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          // fall through with defaults
        }
        const model = typeof body.model === 'string' ? body.model : 'unknown';
        const name = NAMES.find((n) => model === modelFor(n)) ?? ('ALPHA' as Name);
        requests.push({ model, at: Date.now() });

        const lastText = [...(body.messages ?? [])]
          .reverse()
          .map((m) =>
            typeof m.content === 'string'
              ? m.content
              : Array.isArray(m.content)
                ? m.content
                    .map((p) =>
                      p && typeof p === 'object' && 'text' in p
                        ? String((p as { text?: unknown }).text ?? '')
                        : '',
                    )
                    .join(' ')
                : '',
          )
          .find((t) => t.includes(runMarker(name)));
        // Marker-gated reply: readiness probes (no marker in the prompt)
        // must not produce E2ELR markers or usage — they would satisfy the
        // isolation assertions and shift the token counters this spec
        // asserts exact values for.
        const isRealPrompt = Boolean(lastText);
        const echoed = lastText?.match(new RegExp(runMarker(name)))?.[0] ?? '';
        const reply = isRealPrompt
          ? `${replyMarker(name)} acknowledged ${echoed} on model ${model}`
          : 'probe acknowledged';

        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        });
        // Delay so all four sends happen while every run is still streaming.
        setTimeout(() => {
          const mid = Math.floor(reply.length / 2);
          for (const piece of [reply.slice(0, mid), reply.slice(mid)]) {
            res.write(
              `data: ${JSON.stringify({
                id: `chatcmpl-e2elr-${name}`,
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
              })}\n\n`,
            );
          }
          res.write(
            `data: ${JSON.stringify({
              id: `chatcmpl-e2elr-${name}`,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
              usage: isRealPrompt
                ? {
                    prompt_tokens: PROMPT_TOKENS[name],
                    completion_tokens: COMPLETION_TOKENS[name],
                  }
                : { prompt_tokens: 0, completion_tokens: 0 },
            })}\n\n`,
          );
          res.write('data: [DONE]\n\n');
          res.end();
        }, STUB_DELAY_MS);
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `no route ${url}` } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

// ── Provider registration over a raw WebSocket (same port, token in URL) ──

/**
 * The standalone server attaches its WebSocketServer to the HTTP listener
 * (server-runtime.ts) — one shared port. A plain Node WebSocket with the
 * token in the query string passes verifyClient exactly like the browser.
 */
async function addStubProvider(baseURL: string, token: string, stubPort: number): Promise<void> {
  const wsUrl = `${baseURL.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(wsUrl);
  const opened = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error(`ws connect failed: ${wsUrl}`)));
  });
  await opened;

  // The provider record PERSISTS in the shared config store across server
  // restarts — a previous run of this spec (or a crashed one) leaves
  // 'e2e-lr-stub' behind with a dead stub port baked into its baseUrl, and
  // provider.add refuses duplicates. Remove first so every run registers
  // the CURRENT stub port.
  ws.send(JSON.stringify({ type: 'provider.remove', payload: { providerId: PROVIDER_ID } }));
  await new Promise((resolve) => setTimeout(resolve, 1_000));

  const result = new Promise<{ ok: boolean; message: string }>((resolve) => {
    ws.addEventListener('message', (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          type?: string;
          payload?: { success?: boolean; message?: string };
        };
        if (msg.type === 'key.operation_result') {
          resolve({
            ok: msg.payload?.success === true,
            message: String(msg.payload?.message ?? ''),
          });
        }
      } catch {
        // non-JSON frame
      }
    });
  });
  ws.send(
    JSON.stringify({
      type: 'provider.add',
      payload: {
        id: PROVIDER_ID,
        family: 'openai-compatible',
        baseUrl: `http://127.0.0.1:${stubPort}/v1`,
        apiKey: 'e2e-stub-key',
        models: NAMES.map(modelFor),
      },
    }),
  );
  const timeoutMs = 15_000;
  const settled = await Promise.race([
    result,
    new Promise<{ ok: boolean; message: string }>((resolve) =>
      setTimeout(() => resolve({ ok: false, message: 'provider.add timed out' }), timeoutMs),
    ),
  ]);
  ws.close();
  if (!settled.ok) {
    throw new Error(`provider.add failed: ${settled.message}`);
  }
}

/**
 * Best-effort cleanup: drop the stub provider from the persistent config
 * store so the spec leaves no trace (and a re-run never meets a stale
 * baseUrl pointing at a dead stub port).
 */
async function removeStubProvider(baseURL: string, token: string): Promise<void> {
  const wsUrl = `${baseURL.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve());
    ws.addEventListener('error', () => reject(new Error(`ws connect failed: ${wsUrl}`)));
  });
  const done = new Promise<void>((resolve) => {
    ws.addEventListener('message', (ev: MessageEvent) => {
      try {
        const msg = JSON.parse(String(ev.data)) as { type?: string };
        if (msg.type === 'key.operation_result') resolve();
      } catch {
        // non-JSON frame
      }
    });
  });
  ws.send(JSON.stringify({ type: 'provider.remove', payload: { providerId: PROVIDER_ID } }));
  await Promise.race([done, new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
  ws.close();
}

// ── Session seeding (DefaultSessionStore → the server's own sessions dir) ─

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
      const writer = await store.create({
        id: sessionIdFor(name),
        title: `E2ELR ${name}`,
        provider: PROVIDER_ID,
        model: modelFor(name),
      });
      for (let i = 0; i < SEED_COUNT; i++) {
        const event: SeededEvent = {
          type: 'user_input',
          ts: new Date(Date.now() - (SEED_COUNT - i) * 60_000).toISOString(),
          // History titles come from the FIRST prompt truncated ~50 chars:
          // the session NAME sits inside the prefix, every unique marker
          // far beyond it (same constraint as four-tab-no-mixing.spec.ts).
          content: `E2ELR ${name} fixture prompt ${i + 1}/${SEED_COUNT}. Padding so the unique seed marker sits beyond the History title truncation: ${seedMarker(name)}`,
        };
        await writer.append(event);
      }
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
        console.log(`[four-tab-live-runs] cleanup skipped for ${name}: ${String(err)}`);
      }
    }
  } finally {
    await store.dispose?.();
  }
}

// ── Standalone server restart (verbatim strategy from four-tab spec) ───────

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

  // Log the spawned server: a silent server made the "Disconnected from
  // backend" failure undiagnosable — the page's sends were being dropped
  // and nothing on the server side was inspectable after the fact.
  const outFd = fs.openSync(path.join(cwd, '.temp_files', 'e2elr-standalone.out.log'), 'a');
  const errFd = fs.openSync(path.join(cwd, '.temp_files', 'e2elr-standalone.err.log'), 'a');
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
    stdio: ['ignore', outFd, errFd],
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

// ── Tab strip helpers (from four-tab spec) ─────────────────────────────────

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

async function tabStrip(page: Page) {
  return page.getByRole('tablist', { name: 'Open session tabs' });
}

async function switchToSession(page: Page, sessionId: string): Promise<void> {
  const titles = await tabTitles(page);
  const slot = titles.findIndex((t) => sessionFromTitle(t) === sessionId);
  if (slot === -1) {
    throw new Error(`no tab holds session ${sessionId}; strip holds: ${titles.join(' | ')}`);
  }
  const tab = (await tabStrip(page)).getByRole('tab').nth(slot);
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 });
}

async function closeTabsNotIn(page: Page, keep: string[]): Promise<void> {
  const tabs = (await tabStrip(page)).getByRole('tab');
  for (let slot = (await tabTitles(page)).length - 1; slot >= 0; slot--) {
    const titles = await tabTitles(page);
    if (titles.length <= 1) break;
    const id = sessionFromTitle(titles[slot] ?? '');
    if (!id || keep.includes(id)) continue;
    const tab = tabs.nth(slot);
    await tab.hover();
    await tab.getByTitle('Close tab').click();
    // An empty tab closes instantly; a tab with history or a live run now
    // asks first. Confirm whenever the close dialog appears.
    const confirmClose = page
      .getByRole('dialog')
      .getByRole('button', { name: /Interrupt and Close|Close Tab/i });
    try {
      await confirmClose.click({ timeout: 2_000 });
    } catch {
      // Empty tab: no dialog appeared, the tab is already closed.
    }
  }
}

async function openFixtureTab(page: Page, name: Name): Promise<void> {
  const want = sessionIdFor(name);
  const keep = NAMES.map(sessionIdFor);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if ((await openTabIds(page)).includes(want)) return;
    // A server boot-shell (or any live session the runtime announces while
    // nothing is in front) can claim a strip slot between sweeps, and a full
    // strip turns every openTab into a silent tabs_full — so reclaim the
    // slots before each click, not only after the first open.
    await closeTabsNotIn(page, keep);
    const entry = page
      .getByRole('dialog', { name: 'Side panel' })
      .getByRole('button', { name: new RegExp(`E2ELR ${name} fixture`) })
      .first();
    await entry.click({ timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(2_000);
  }
  throw new Error(
    `fixture tab for ${name} never opened; strip holds: ${(await openTabIds(page)).join(', ')}`,
  );
}

// ── The proof ──────────────────────────────────────────────────────────────

test.describe('four-tab live runs', () => {
  // Tall viewport: the transcript virtualizes, and every marker assertion
  // must find its bubble mounted (same constraint as four-tab-no-mixing).
  test.use({ viewport: { width: 1280, height: 2400 } });

  test.skip(
    !process.env.WEBUI_URL || !process.env.WEBUI_E2E_TOKEN,
    'needs the standalone multi-session server: WEBUI_URL + WEBUI_E2E_TOKEN',
  );

  test('four concurrent runs stay on their own tabs end to end', async ({ page, baseURL }) => {
    test.setTimeout(420_000);
    const token = process.env.WEBUI_E2E_TOKEN as string;

    const stub = await startStubProvider();
    let seeded = false;
    try {
      // ── Seed → register the stub provider (no restart after seeding) ──
      // The project catalog server is spawned by a webui boot and its fixture
      // upserts live in THAT catalog server instance. A restart AFTER seeding
      // kills it (a fresh catalog server starts with only its own boot shell —
      // the "ALPHA never opened / empty History" failure), so: restart once to
      // get a known-good server + catalog, seed through its live catalog
      // client, then go straight to the page. The agent registry is cold for
      // the seeded sessions by construction (fresh home, never adopted), which
      // is the state the original pre-page restart existed to guarantee.
      await restartStandaloneServer(baseURL as string, token);
      await seedFourSessions();
      seeded = true;

      await page.goto(`${baseURL}/?token=${encodeURIComponent(token)}`);
      await page.locator('textarea').first().waitFor({ timeout: 20_000 });
      // Reset persisted client state (lanes, open tabs, prefs like Enhance):
      // tabs restored from localStorage open WITHOUT a page-driven
      // session.resume, and the runtime keeps their agents on placeholder
      // writers — every user_message then bounces with session_not_ready.
      // A clean store forces the real flow: History click → the PAGE
      // resumes each session on its own connection.
      await page.evaluate(() => localStorage.clear());
      await page.reload();
      await page.locator('textarea').first().waitFor({ timeout: 20_000 });
      await addStubProvider(baseURL as string, token, stub.port);

      // ── Wire evidence: every frame this PAGE receives, on its socket ──
      // The capture listener must exist BEFORE the socket it watches: the
      // page's original socket from the goto above predates it, so we
      // reload — the reconnect lands on a socket this listener sees, and
      // every replay/run frame from here on is recorded.
      const runResults: Array<{ sessionId: string; at: number }> = [];
      const sessionFrames: Array<{ type: string; sessionId: string | null; at: number }> = [];
      const textDeltasBySession = new Map<string, number>();
      const errorFrames: string[] = [];
      page.on('websocket', (ws) => {
        ws.on('framereceived', (frame) => {
          try {
            const msg = JSON.parse(String(frame.payload ?? '{}')) as {
              type?: string;
              payload?: { sessionId?: string; message?: string };
            };
            if (msg.type === 'run.result' && msg.payload?.sessionId) {
              runResults.push({ sessionId: msg.payload.sessionId, at: Date.now() });
            }
            if (
              typeof msg.type === 'string' &&
              msg.type.startsWith('session.') &&
              sessionFrames.length < 200
            ) {
              sessionFrames.push({
                type: msg.type,
                sessionId: msg.payload?.sessionId ?? null,
                at: Date.now(),
              });
            }
            if (msg.type === 'provider.text_delta' && msg.payload?.sessionId) {
              const sid = msg.payload.sessionId;
              textDeltasBySession.set(sid, (textDeltasBySession.get(sid) ?? 0) + 1);
            }
            if (msg.type === 'error' && errorFrames.length < 10) {
              errorFrames.push(String(msg.payload?.message ?? '(no message)'));
            }
          } catch {
            // non-JSON frame
          }
        });
      });
      await page.reload();
      await page.locator('textarea').first().waitFor({ timeout: 20_000 });

      // The page must be on a LIVE socket before anything is sent — a
      // "Disconnected from backend" page silently swallows every send and
      // the run assertions below then fail for the wrong reason.
      const disconnected = page.getByRole('status').filter({ hasText: 'Disconnected' });
      await expect(disconnected, 'page socket must be connected before sending').toHaveCount(0, {
        timeout: 30_000,
      });

      // ── Open all four from History into the tab strip ─────────────────
      for (const name of NAMES) {
        await openFixtureTab(page, name);
        if (name === NAMES[0]) {
          await closeTabsNotIn(page, NAMES.map(sessionIdFor));
        }
      }
      await closeTabsNotIn(page, NAMES.map(sessionIdFor));
      const stripIds = await openTabIds(page);
      expect(new Set(stripIds).size, 'exactly the four fixture tabs').toBe(4);

      // The composer's Enter path routes through the prompt-refine panel
      // when Enhance is enabled (a PERSISTED local pref — the browser
      // profile this spec runs in may have it on): the composer clears,
      // the panel opens, and nothing is ever sent. Disable it — it is one
      // shared pref, so one click covers all four tabs.
      const refineOn = page.locator('button[title="Refining enabled — click to disable"]');
      if ((await refineOn.count()) > 0) {
        await refineOn.first().click();
        await expect(
          page.locator('button[title="Refining disabled — click to enable"]').first(),
        ).toBeVisible({ timeout: 5_000 });
      }

      // A tab whose session.resume never completed server-side opens
      // client-side but has NO agent behind it — every user_message then
      // bounces with "not open in this runtime yet". Gate the sends on
      // all four session.start confirmations instead of assuming them.
      {
        const hasStart = (n: Name) =>
          sessionFrames.some((f) => f.type === 'session.start' && f.sessionId === sessionIdFor(n));
        const deadline = Date.now() + 60_000;
        while (Date.now() < deadline && NAMES.filter(hasStart).length < NAMES.length) {
          await page.waitForTimeout(1_000);
        }
        const missing = NAMES.filter((n) => !hasStart(n));
        if (missing.length > 0) {
          throw new Error(
            `session.resume never completed for ${missing.join(', ')}; ` +
              `session frames seen: ${JSON.stringify(sessionFrames.slice(0, 40))}`,
          );
        }
      }

      // ── Readiness probes ─────────────────────────────────────────────
      // session.start alone is not enough: an agent restored from a
      // persisted lane can emit it while still carrying the PLACEHOLDER
      // writer — user_messages then bounce with session_not_ready ("Resume
      // it and send again"). Probe each session on a private socket; on
      // rejection, force a real resume via its History entry and probe
      // again. Acceptance = the probe run's iteration.started arriving.
      // Controlled-experiment switch: with clean localStorage the page's
      // own History-click resumes install the writers and the probe-socket
      // path can be skipped (E2ELR_PROBES=1 restores it for persisted-lane
      // states). The socket itself stays open either way — passive.
      const probesEnabled = process.env.E2ELR_PROBES === '1';
      const probeUrl = `${(baseURL as string).replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(
        token,
      )}`;
      const probeWs = new WebSocket(probeUrl);
      await new Promise<void>((resolve, reject) => {
        probeWs.addEventListener('open', () => resolve());
        probeWs.addEventListener('error', () => reject(new Error('probe ws connect failed')));
      });
      const probeEvents: Array<{ sessionId: string; kind: string }> = [];
      probeWs.addEventListener('message', (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data)) as {
            type?: string;
            payload?: { sessionId?: string; phase?: string };
          };
          const sid = msg.payload?.sessionId;
          if (!sid) return;
          if (msg.type === 'error' && msg.payload?.phase === 'user_message') {
            probeEvents.push({ sessionId: sid, kind: 'not_ready' });
          } else if (msg.type === 'iteration.started') {
            probeEvents.push({ sessionId: sid, kind: 'accepted' });
          } else if (msg.type === 'run.result') {
            probeEvents.push({ sessionId: sid, kind: 'run_result' });
          }
        } catch {
          // non-JSON frame
        }
      });
      const waitForProbe = async (
        sid: string,
        kinds: string[],
        ms: number,
      ): Promise<string | null> => {
        const deadline = Date.now() + ms;
        while (Date.now() < deadline) {
          const hit = [...probeEvents]
            .reverse()
            .find((e) => e.sessionId === sid && kinds.includes(e.kind));
          if (hit) return hit.kind;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        return null;
      };
      if (probesEnabled) {
        for (const name of NAMES) {
          const sid = sessionIdFor(name);
          for (let attempt = 1; attempt <= 5; attempt++) {
            // A DIRECT session.resume is the only reliable trigger: an
            // already-open tab's History click short-circuits client-side
            // (openTab returns 'already_active' without resuming), and the
            // placeholder writer is only replaced by the resume transition
            // itself — which is runtime-scoped, so any socket may trigger it.
            probeWs.send(JSON.stringify({ type: 'session.resume', payload: { id: sid } }));
            await page.waitForTimeout(1_500);
            probeWs.send(
              JSON.stringify({
                type: 'user_message',
                payload: {
                  id: `e2elr_probe_${name}_${attempt}_${Date.now()}`,
                  content: `readiness probe for ${name}, attempt ${attempt}.`,
                  timestamp: Date.now(),
                  sessionId: sid,
                },
              }),
            );
            const outcome = await waitForProbe(sid, ['accepted', 'not_ready'], 8_000);
            if (outcome === 'accepted') break;
            if (attempt === 5) {
              probeWs.close();
              throw new Error(
                `session ${sid} never accepted a probe (placeholder writer persisted ` +
                  `after 5 direct resumes); probe events: ${JSON.stringify(probeEvents)}`,
              );
            }
            await page.waitForTimeout(1_000);
          }
          // Let accepted probe runs FINISH before the real sends, so their
          // run.results cannot pollute the real-run completion/simultaneity
          // math below (probe runs carry zero usage — stub is marker-gated).
          {
            const deadline = Date.now() + 30_000;
            while (Date.now() < deadline) {
              const settled = NAMES.every((n) =>
                probeEvents.some((e) => e.sessionId === sessionIdFor(n) && e.kind === 'run_result'),
              );
              if (settled) break;
              await page.waitForTimeout(500);
            }
          }
        }
      }
      const probeCutoff = runResults.length;
      // probeWs stays OPEN: the runtime ties the resumed agents' lifecycle
      // to the connection that resumed them — closing this socket retired
      // the sessions and the composer sends bounced with session_not_ready.

      // ── Fire four runs back-to-back, no waiting between sends ─────────
      const sendTimes: Record<Name, number> = {
        ALPHA: 0,
        BRAVO: 0,
        CHARLIE: 0,
        DELTA: 0,
      };
      // Per-tab agent-state log: opening a fixture whose journal ends
      // mid-turn (user_input with no reply) can leave the lane's spinner
      // stuck on — Enter then takes the btw/enqueue branch and no run ever
      // starts. Clearing via the composer's Stop button resets the lane.
      const agentStates: Record<string, string> = {};
      const agentChip = page.locator('header span[title^="Agent state:"]');
      const readAgentState = async (): Promise<string> =>
        (
          await agentChip
            .first()
            .innerText({ timeout: 5_000 })
            .catch(() => 'unknown')
        ).trim();

      for (const name of NAMES) {
        await switchToSession(page, sessionIdFor(name));
        // The shared composer's [sessionId] effect resets the whole unsent
        // draft (text included) the moment the tab changes — settle first.
        await page.waitForTimeout(400);
        const state = await readAgentState();
        agentStates[sessionIdFor(name)] = state;
        if (state !== 'idle') {
          // Stop clears the lane's isLoading client-side (handleAbort →
          // setLoading(false)); the server-side abort of a non-existent
          // run is a harmless no-op.
          await page.locator('button[title="Abort the current run"]').first().click();
          await expect.poll(readAgentState, { timeout: 10_000 }).toBe('idle');
        }
        const composer = page.locator('textarea').first();
        await composer.fill(RUN_PROMPT(name));
        await composer.press('Enter');
        // A successful submit clears the composer; text still sitting there
        // means the send never happened — fail loudly instead of waiting
        // 120s for run.results that can never arrive.
        await expect.poll(async () => composer.inputValue(), { timeout: 5_000 }).toBe('');
        sendTimes[name] = Date.now();
        // Small settle so the user_message is on the wire before we switch.
        await page.waitForTimeout(500);
      }
      const lastSend = Math.max(...Object.values(sendTimes));

      // ── Wait for all four runs to finish (stub delay + agent overhead) ─
      // Probe results (before probeCutoff) are excluded: only the real
      // four sends count.
      const realRunResults = (): Array<{ sessionId: string; at: number }> =>
        runResults.slice(probeCutoff);
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        const done = NAMES.filter((n) =>
          realRunResults().some((r) => r.sessionId === sessionIdFor(n)),
        );
        if (done.length === NAMES.length) break;
        await page.waitForTimeout(1_000);
      }
      const finished = NAMES.filter((n) =>
        realRunResults().some((r) => r.sessionId === sessionIdFor(n)),
      );
      expect(
        finished,
        `every session produced a run.result; saw ${JSON.stringify(realRunResults())}; ` +
          `agent states at send time: ${JSON.stringify(agentStates)}; ` +
          `text_deltas by session: ${JSON.stringify([...textDeltasBySession])}; ` +
          `error frames: ${JSON.stringify(errorFrames)}`,
      ).toHaveLength(NAMES.length);

      // Simultaneity: with the 4s stub delay every run was still streaming
      // when the LAST send went out — four live runs, one socket, one page.
      const firstResult = Math.min(...realRunResults().map((r) => r.at));
      expect(firstResult, 'all four runs were in flight at the last send').toBeGreaterThan(
        lastSend,
      );

      // ── The isolation matrix: per tab, own everything; foreign nothing ─
      for (const name of NAMES) {
        await switchToSession(page, sessionIdFor(name));

        // Transcript — positives (seed replay + own run + own reply).
        await expect(page.getByText(runMarker(name)).first()).toBeVisible({
          timeout: 20_000,
        });
        await expect(page.getByText(replyMarker(name)).first()).toBeVisible();
        await expect(page.getByText(seedMarker(name)).first()).toBeVisible();

        // Transcript — negatives: no foreign marker anywhere in the DOM.
        for (const other of NAMES) {
          if (other === name) continue;
          await expect(page.getByText(runMarker(other))).toHaveCount(0);
          await expect(page.getByText(replyMarker(other))).toHaveCount(0);
          await expect(page.getByText(seedMarker(other))).toHaveCount(0);
        }

        // Menu — the header's provider/model chip is THIS session's.
        const header = page.locator('header').first();
        const chip = header.getByRole('button').filter({ hasText: PROVIDER_ID });
        await expect(chip).toBeVisible();
        await expect(chip).toContainText(modelFor(name));
        for (const other of NAMES) {
          if (other === name) continue;
          await expect(chip).not.toContainText(modelFor(other));
        }

        // Counter — the tab strip shows THIS session's token total.
        const titles = await tabTitles(page);
        const slot = titles.findIndex((t) => sessionFromTitle(t) === sessionIdFor(name));
        const tab = (await tabStrip(page)).getByRole('tab').nth(slot);
        await expect(tab).toContainText(TOK_LABEL[name]);
        for (const other of NAMES) {
          if (other === name) continue;
          await expect(tab).not.toContainText(TOK_LABEL[other]);
        }
      }

      // ── Second switch cycle: nothing parked, lost, or swapped ─────────
      for (const name of [...NAMES].reverse()) {
        await switchToSession(page, sessionIdFor(name));
        await expect(page.getByText(replyMarker(name)).first()).toBeVisible();
        await expect(page.getByText(runMarker(name)).first()).toBeVisible();
        const titles = await tabTitles(page);
        const slot = titles.findIndex((t) => sessionFromTitle(t) === sessionIdFor(name));
        await expect((await tabStrip(page)).getByRole('tab').nth(slot)).toContainText(
          TOK_LABEL[name],
        );
      }

      console.log(
        JSON.stringify({
          event: 'e2elr.done',
          stubRequests: stub.requests.length,
          runResults: runResults.length,
          lastSend,
          firstResult,
        }),
      );
    } finally {
      try {
        probeWs?.close();
      } catch {
        // already closed
      }
      if (seeded) {
        // Sessions held live by the server refuse store.delete — restart
        // first (also leaves a clean server behind for global-teardown).
        await restartStandaloneServer(baseURL as string, token).catch(() => {});
        await deleteFourSessionsBestEffort();
      }
      // Scrub the stub provider even when the test failed early — the
      // record persists in the shared config store and its baseUrl points
      // at THIS run's stub port, which is about to stop listening.
      await removeStubProvider(baseURL as string, token).catch(() => {});
      await stub.close();
    }
  });
});
