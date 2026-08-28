import { execSync, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';

/**
 * Per-session worklist — the 2nd menu area (Work section: Todos / Plan) must
 * show ONLY the foreground session's data.
 *
 * Regression shape this pins: the worklist routes used to bind every request
 * to the shared root context, so all four tabs rendered one merged list, and
 * PlanPanel/TasksPanel never refetched on tab switch.
 *
 * Requires the STANDALONE multi-session server (`webui-server` entry), not
 * the CLI-embedded single-session host — the embedded host's session gate
 * rejects resume-to-background-session requests by design. Boot it with:
 *
 *   WEBUI_TOKEN=t WEBUI_DIST_DIR=packages/webui/dist \
 *     node packages/webui-server/dist/server/entry.js
 *
 * and run with WEBUI_URL + WEBUI_E2E_TOKEN pointing at it. Skipped otherwise.
 *
 * Fixture strategy — no LLM calls, no server restart. The mechanics:
 *   - `plan.get` reads the session's `.plan.json` from disk on every request.
 *   - `todos` for a session LIVE in the agent registry are served from
 *     in-memory context; the full resume path — which loads `.todos.json`
 *     from the checkpoint — runs for any session NOT yet live in this
 *     server process.
 *
 * So the test picks two pre-existing small on-disk sessions (fast replays),
 * seeds their sidecars, and opens them from History. Every open is a full
 * resume that loads its own sidecars; switching tabs then proves each Work
 * panel renders only its own session's rows.
 */

const X_TODOS = ['Xray todo one', 'Xray todo two'];
const X_PLAN = ['Xray plan step one', 'Xray plan step two'];
const Y_TODOS = ['Yankee todo one'];
const Y_PLAN = ['Yankee plan step one'];

/**
 * Sessions live either under `<repo>/.wrongstack/sessions` or under
 * `~/.wrongstack/projects/<slug>/sessions`, date-sharded
 * (`2026-08-26/sess_<ULID>`). Finds the directory owning `sessionId`'s
 * transcript — the shard subdir when the layout is sharded, the sessions
 * root when it is flat, because sidecars are written beside the journal.
 */
async function resolveSessionsDir(sessionId: string): Promise<string> {
  const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
  const projectsRoot = path.join(home, '.wrongstack', 'projects');
  const dirs = [path.join(process.cwd(), '.wrongstack', 'sessions')];
  for (const entry of await fs.readdir(projectsRoot, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) dirs.push(path.join(projectsRoot, entry.name, 'sessions'));
  }
  for (const dir of dirs) {
    if (await fs.stat(path.join(dir, `${sessionId}.jsonl`)).then(() => true, () => false)) {
      return dir;
    }
    // Date-sharded layout: `<dir>/<YYYY-MM-DD>/<sessionId>.jsonl`.
    for (const shard of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (!shard.isDirectory()) continue;
      const sharded = path.join(dir, shard.name, `${sessionId}.jsonl`);
      if (await fs.stat(sharded).then(() => true, () => false)) {
        return path.join(dir, shard.name);
      }
    }
  }
  throw new Error(`sessions directory not found for ${sessionId}; tried:\n  ${dirs.join('\n  ')}`);
}

/** True when `sessionId` has a transcript file on disk (flat or sharded). */
async function sessionHasJournal(sessionId: string): Promise<boolean> {
  try {
    await resolveSessionsDir(sessionId);
    return true;
  } catch {
    return false;
  }
}

async function seedWorklist(
  sessionId: string,
  todoContents: string[],
  planTitles: string[],
): Promise<void> {
  const sessionsDir = await resolveSessionsDir(sessionId);
  const now = new Date().toISOString();
  await fs.mkdir(sessionsDir, { recursive: true });
  await fs.writeFile(
    path.join(sessionsDir, `${sessionId}.todos.json`),
    JSON.stringify({
      version: 1,
      sessionId,
      updatedAt: now,
      todos: todoContents.map((content, index) => ({
        id: `seed-${index + 1}`,
        content,
        status: 'pending',
      })),
    }),
    'utf8',
  );
  await fs.writeFile(
    path.join(sessionsDir, `${sessionId}.plan.json`),
    JSON.stringify({
      version: 1,
      sessionId,
      updatedAt: now,
      items: planTitles.map((title, index) => ({
        id: `plan-seed-${index + 1}`,
        title,
        status: 'open',
        createdAt: now,
        updatedAt: now,
      })),
    }),
    'utf8',
  );
}

/** Tab titles in one atomic DOM read — no count/nth re-resolution race. */
async function tabTitles(page: Page): Promise<string[]> {
  return page
    .getByRole('tablist', { name: 'Open session tabs' })
    .getByRole('tab')
    .evaluateAll((els) => els.map((el) => el.getAttribute('title') ?? ''));
}

/** Session id held by a tab (3rd line of its title tooltip). */
function sessionFromTitle(title: string): string | undefined {
  return title.split('\n')[2]?.trim() || undefined;
}

async function openTabIds(page: Page): Promise<string[]> {
  const ids = (await tabTitles(page)).map(sessionFromTitle).filter(Boolean) as string[];
  return ids;
}

async function foregroundSessionId(page: Page): Promise<string | undefined> {
  const title = await page
    .getByRole('tablist', { name: 'Open session tabs' })
    .getByRole('tab')
    // evaluateAll serializes its return — extract the title INSIDE the
    // browser context; the element itself cannot cross back to Node.
    .evaluateAll((els) => {
      const el = els.find((candidate) => candidate.getAttribute('aria-selected') === 'true');
      return el?.getAttribute('title') ?? '';
    });
  return sessionFromTitle(title);
}

/** Slot index holding `sessionId` — stable across reorders, unlike fixed indexes. */
async function slotOfSession(page: Page, sessionId: string): Promise<number> {
  const titles = await tabTitles(page);
  const slot = titles.findIndex((t) => sessionFromTitle(t) === sessionId);
  if (slot === -1) {
    throw new Error(`no tab holds session ${sessionId}; strip holds: ${titles.join(' | ')}`);
  }
  return slot;
}

async function switchToSession(page: Page, sessionId: string): Promise<void> {
  const slot = await slotOfSession(page, sessionId);
  const tab = page.getByRole('tablist', { name: 'Open session tabs' }).getByRole('tab').nth(slot);
  await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 });
}

/** Close every tab whose session is not in `keep` (never leaves the strip empty). */
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

/**
 * Open every session in `wanted` through the side panel's History list.
 * Entries cannot be mapped to ids by text, so each candidate is clicked and
 * verified by the FOREGROUND tab's tooltip id; wrong sessions are retired.
 * Only "0 tok" entries are clicked — empty sessions replay instantly, while
 * titled transcripts can be tens of MB and would stall the test.
 */
async function reopenFromHistory(page: Page, wanted: string[]): Promise<void> {
  const panel = page.getByRole('dialog', { name: 'Side panel' });
  const entries = panel.getByRole('button', { name: /· 0 tok/ });
  const deadline = Date.now() + 150_000;
  let idx = 0;
  while (Date.now() < deadline) {
    const open = await openTabIds(page);
    if (wanted.every((id) => open.includes(id))) return;
    await closeTabsNotIn(page, [...wanted, (await foregroundSessionId(page)) ?? '']);
    const total = await entries.count();
    if (total === 0 || idx >= total) {
      await page.waitForTimeout(800);
      idx = 0;
      continue;
    }
    await entries.nth(idx).click();
    await page.waitForTimeout(1_000); // resume + replay settles
    idx++;
  }
  throw new Error(
    `timed out reopening ${wanted.join(', ')} from history; strip holds: ${(await openTabIds(page)).join(', ')}`,
  );
}

/** Expand the Work dock section — session transitions re-collapse it. */
async function openWorkSection(page: Page): Promise<void> {
  const expand = page.getByTitle('Expand Work');
  if ((await expand.count()) > 0) await expand.click();
  await expect(page.locator('#panel-work')).toBeVisible({ timeout: 10_000 });
}

/** PIDs listening on `port` (Windows netstat -ano; no nested quoting). */
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

/**
 * Restart the standalone server so every session leaves the live-agent
 * registry. Todos for a session LIVE in the registry are served from
 * in-memory context (disk seeds never read there); only the full resume —
 * taken when a session is not live — loads `.todos.json` from the checkpoint.
 * A fresh process therefore turns every subsequent open into a seed-loading
 * resume. Kills exactly the process listening on the test's own port —
 * never a peer's server on another port.
 */
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

interface ListedSession {
  id: string;
  title?: string | undefined;
  tokenTotal?: number | undefined;
  isCurrent?: boolean | undefined;
}

/**
 * Reload and capture the `sessions.list` frame the client receives on
 * connect. The panel's History list is recency-limited, so fixture sessions
 * must come from THIS list — anything older simply cannot be clicked.
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

test.describe('per-session worklist', () => {
  test.skip(
    !process.env.WEBUI_URL || !process.env.WEBUI_E2E_TOKEN,
    'needs the standalone multi-session server: WEBUI_URL + WEBUI_E2E_TOKEN',
  );

  test.beforeEach(async ({ page, baseURL }) => {
    const token = process.env.WEBUI_E2E_TOKEN as string;
    await page.goto(`${baseURL}/?token=${encodeURIComponent(token)}`);
    await page.locator('textarea').first().waitFor({ timeout: 20_000 });
  });

  test('each tab renders only its own todos and plan across switches', async ({
    page,
    baseURL,
  }) => {
    test.setTimeout(240_000);
    const token = process.env.WEBUI_E2E_TOKEN as string;
    const work = page.locator('#panel-work');

    // ── Pick two fixture sessions the panel can actually open ──
    // The History list is recency-limited, so candidates come from the
    // server's own sessions.list frame. Only untitled 0-token entries:
    // their replays are instant, and titled transcripts can be tens of MB.
    const listed = await captureSessionsList(page);
    // The server fills empty sessions' display title with the literal
    // "(empty session)" — that IS the untitled case, not a real title.
    const untitled = (s: ListedSession) => !s.title || s.title === '(empty session)';
    const candidates = listed.filter(
      (s) => !s.isCurrent && untitled(s) && (s.tokenTotal ?? 0) === 0,
    );
    // A catalog entry without an on-disk journal (minted by a boot, never
    // written) cannot be seeded or resumed — the fixture strategy needs
    // real transcript files. Keep the two most RECENT resolvable ones.
    const resolvable: { id: string }[] = [];
    for (const s of candidates) {
      if (await sessionHasJournal(s.id)) resolvable.push(s as { id: string });
      if (resolvable.length >= 2) break;
    }
    expect(
      resolvable.length,
      'at least two openable 0-token sessions with on-disk journals',
    ).toBeGreaterThanOrEqual(2);
    const x = resolvable[0] as { id: string };
    const y = resolvable[1] as { id: string };
    expect(x.id).not.toBe(y.id);

    // ── Seed, restart, reopen: the full user story ──
    await seedWorklist(x.id, X_TODOS, X_PLAN);
    await seedWorklist(y.id, Y_TODOS, Y_PLAN);
    // Restart empties the live-agent registry: X and Y were the most RECENT
    // sessions, so this server process still holds them live — and live
    // sessions serve in-memory todos, never the disk seed. A fresh process
    // turns every subsequent open into a full resume that loads the seeded
    // checkpoints from disk.
    await restartStandaloneServer(baseURL as string, token);
    await page.reload();
    await page.locator('textarea').first().waitFor({ timeout: 20_000 });
    await reopenFromHistory(page, [x.id, y.id]);

    // ── X's lists — and nothing from Y ──
    await switchToSession(page, x.id);
    await openWorkSection(page);
    await expect(work.getByText('Xray todo one')).toBeVisible({ timeout: 20_000 });
    await expect(work.getByText('Xray todo two')).toBeVisible();
    await expect(work.getByText('Yankee todo one')).toHaveCount(0);

    await work.getByRole('button', { name: /Plan/i }).click();
    await expect(work.getByText('Xray plan step one')).toBeVisible({ timeout: 20_000 });
    await expect(work.getByText('Xray plan step two')).toBeVisible();
    await expect(work.getByText('Yankee plan step one')).toHaveCount(0);

    // ── Y's lists — and none of X's ──
    await switchToSession(page, y.id);
    await openWorkSection(page);
    await work.getByRole('button', { name: /Todos/i }).click();
    await expect(work.getByText('Yankee todo one')).toBeVisible({ timeout: 20_000 });
    await expect(work.getByText('Xray todo one')).toHaveCount(0);
    await expect(work.getByText('Xray todo two')).toHaveCount(0);

    await work.getByRole('button', { name: /Plan/i }).click();
    await expect(work.getByText('Yankee plan step one')).toBeVisible({ timeout: 20_000 });
    await expect(work.getByText('Xray plan step one')).toHaveCount(0);

    // ── Back to X: survives the round trip, no Y bleed ──
    await switchToSession(page, x.id);
    await openWorkSection(page);
    await work.getByRole('button', { name: /Todos/i }).click();
    await expect(work.getByText('Xray todo one')).toBeVisible({ timeout: 20_000 });
    await expect(work.getByText('Yankee todo one')).toHaveCount(0);

    await work.getByRole('button', { name: /Plan/i }).click();
    await expect(work.getByText('Xray plan step one')).toBeVisible({ timeout: 20_000 });
    await expect(work.getByText('Yankee plan step one')).toHaveCount(0);
  });
});
