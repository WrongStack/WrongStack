/**
 * SIGKILL durability: what a real hard kill leaves on disk, and whether it is
 * enough to recover from.
 *
 * A child process writes a realistic turn and is then SIGKILLed with no signal
 * handler, no flush and no `session_end` — the machine-sleep / OOM / taskkill
 * case. In-process tests cannot reproduce this; they always unwind.
 *
 * The contract this locks in is `FileSessionWriter`'s CRITICAL_EVENT_TYPES:
 * `user_input`, `llm_response`, `checkpoint` and the in-flight markers bypass
 * the 500ms / 50-event batch and reach disk immediately, so the conversation
 * and the crash marker survive a kill. Batched non-critical events (here
 * `tool_call_start`) are the accepted loss — bounding those would mean an
 * fsync per event.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { SessionRecovery } from '../../src/storage/session-recovery.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import type { SessionEvent } from '../../src/types/session.js';

const dirs: string[] = [];
afterEach(async () =>
  Promise.all(
    dirs
      .splice(0)
      .map((d) => rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })),
  ),
);

it('survives SIGKILL: critical events reach disk, the crash is detected, the turn replays', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'crash-sigkill-'));
  dirs.push(dir);
  const victim = fileURLToPath(new URL('./session-crash-victim.mts', import.meta.url));

  const child = spawn(process.execPath, ['--import', 'tsx', victim, dir], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  // The victim prints READY once its writes are issued, then parks forever.
  await new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(
      () => reject(new Error(`victim never signalled READY. stderr=${stderr}`)),
      30_000,
    );
    const poll = setInterval(() => {
      if (stdout.includes('READY')) {
        clearTimeout(deadline);
        clearInterval(poll);
        resolve();
      } else if (child.exitCode !== null) {
        clearTimeout(deadline);
        clearInterval(poll);
        reject(new Error(`victim exited early (${child.exitCode}). stderr=${stderr}`));
      }
    }, 50);
  });

  // No handler runs, nothing flushes, no session_end is written.
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));

  const entries = await readdir(dir);
  const day = entries.find((name) => /^\d{4}-\d{2}-\d{2}$/.test(name));
  const sessionId = day ? `${day}/crashme` : 'crashme';
  const types = (await readFile(path.join(dir, `${sessionId}.jsonl`), 'utf8'))
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => (JSON.parse(line) as SessionEvent).type);

  // Every critical type made it through an unannounced kill.
  expect(types).toEqual([
    'session_start',
    'user_input',
    'checkpoint',
    'in_flight_start',
    'llm_response',
  ]);
  // And the batched one did not — the documented tradeoff, asserted so a
  // change in the critical set is a deliberate decision rather than a drift.
  expect(types).not.toContain('tool_call_start');

  const recovery = new SessionRecovery(dir);
  const stale = await recovery.listResumable();
  expect(stale).toHaveLength(1);
  expect(stale[0]?.context).toBe('iteration 0 / tool: read / id: tu-1');

  const store = new DefaultSessionStore({ dir });
  const resumed = await store.resume(sessionId);
  expect(resumed.data.pendingToolUseCount).toBe(1);
  // The usage on the surviving llm_response replays intact, cache included.
  expect(resumed.data.usage).toMatchObject({ input: 100, output: 10, cacheRead: 5_000 });

  const [summary] = await store.list();
  expect(summary?.tokenTotal).toBe(5_110);
  expect(summary?.model).toBe('glm-5.3');
  await resumed.writer.close();
  await store.dispose?.();
}, 60_000);
