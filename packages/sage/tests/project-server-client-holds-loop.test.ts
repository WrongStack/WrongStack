/**
 * A pending SAGE connect must keep its process alive.
 *
 * `connectWithElection` retries for up to 10s, pausing 75ms between attempts.
 * That pause used to be an UNREF'd timer, and the pause is the one moment when
 * nothing else is pending: the previous socket is destroyed and the next one
 * does not exist yet. Node therefore decided the loop was empty and exited 0 —
 * in the middle of `--webui` boot, before the banner. CI saw only "WebUI server
 * exited before it was ready (code 0)" and no stack, because nothing crashed.
 *
 * The assertion is deliberately at process level: an in-process unit test
 * cannot observe "the event loop went idle", which IS the bug. The child awaits
 * a connect that can never succeed and reports whether `beforeExit` fired
 * first.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const sageTestDir = dirname(fileURLToPath(import.meta.url));
// Import specifiers must be file:// URLs — a bare Windows absolute path
// (`D:\...`) is rejected by the ESM loader as an unsupported URL scheme.
const CLIENT_SRC = pathToFileURL(join(sageTestDir, '..', 'src', 'project-server-client.ts')).href;

let projectRoot: string;

beforeEach(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), 'sage-loop-hold-'));
});

afterEach(async () => {
  await rm(projectRoot, { recursive: true, force: true });
});

describe('SAGE project-server client event-loop residency', () => {
  it('does not let the process exit while a connect retry is pending', async () => {
    // The child stubs the detached spawn so no real daemon is started: the
    // endpoint stays dead, every attempt fails fast, and the retry pause is
    // the only thing holding the loop.
    // `connectWithElection` is driven directly rather than through `connect()`:
    // the public entry point refuses before it ever reaches the retry loop when
    // the built daemon is absent, and running from TypeScript source is exactly
    // that case. `private` is erased at runtime, so the probe can call it.
    const script = `
      import { SageProjectServerConnection } from ${JSON.stringify(CLIENT_SRC)};
      const connection = new SageProjectServerConnection(${JSON.stringify(projectRoot)});
      // No real daemon: the endpoint stays dead, every attempt fails fast, and
      // the 75ms retry pause is the only thing left holding the loop.
      Object.getPrototypeOf(connection).spawnDetachedServer = () => {};
      let settled = false;
      connection.connectWithElection(true).then(
        () => { settled = true; },
        () => { settled = true; },
      );
      process.on('beforeExit', () => {
        if (!settled) {
          console.log('IDLE_BEFORE_SETTLED');
          process.exit(3);
        }
      });
    `;
    const scriptPath = join(projectRoot, 'hold-probe.mjs');
    await writeFile(scriptPath, script, 'utf8');

    const child = spawn(process.execPath, ['--import', 'tsx', scriptPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: { ...process.env },
    });
    let stdout = '';
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
    });

    const exit = await new Promise<{ code: number | null }>((resolve) => {
      child.once('exit', (code) => resolve({ code }));
    });

    // With the unref'd timer the child prints IDLE_BEFORE_SETTLED within
    // milliseconds; with a ref'd one it runs the full election deadline and
    // exits only after `connect` rejects.
    expect(stdout).not.toContain('IDLE_BEFORE_SETTLED');
    expect(exit.code).toBe(0);
  }, 45_000);
});
