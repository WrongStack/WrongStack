#!/usr/bin/env node
// Serializes concurrent coverage runs so they cannot corrupt each other's
// coverage/.tmp directory.
//
// Vitest coverage providers write intermediate files below coverage/.tmp. A
// second run can clean that directory while the first run is still reading it,
// so every repository coverage command is routed through this lock.

import { execFileSync, spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = path.join(REPO_ROOT, '.coverage.lock');
const HELD_ENV = 'WRONGSTACK_COVERAGE_LOCK_HELD';
const POLL_MS = 1000;
const DEFAULT_MAX_WAIT_MS = 60 * 60 * 1000;

/**
 * Check whether a process with the given PID is alive.
 *
 * On Windows, `process.kill(pid, 0)` does NOT throw for dead PIDs — it returns
 * true for any PID, including ones that have long exited. This caused stale
 * coverage locks to never be detected, blocking every subsequent coverage run
 * for the full 1h timeout on this host. Instead, we shell out to `tasklist`
 * and parse the CSV output for the PID row. When the probe tool itself fails
 * (ENOENT, timeout), we conservatively assume the process is alive to avoid
 * breaking a valid lock — the age-based timeout in `isStale()` is the backstop.
 *
 * On POSIX, `process.kill(pid, 0)` works correctly (throws ESRCH for dead PIDs).
 *
 * @param pid Process ID to check.
 * @returns `true` if the process is running (or probe failed), `false` if dead.
 */
function defaultCheckProcessAlive(pid) {
  if (process.platform === 'win32') {
    try {
      // Parse the CSV output for the actual PID row rather than relying on
      // exit codes — tasklist can return a non-empty stdout even for misses.
      const stdout = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        timeout: 5000,
      });
      return stdout.includes(`"${pid}"`);
    } catch (error) {
      // tasklist exited non-zero — we may still have parseable output.
      if (error && typeof error.stdout === 'string' && error.stdout.length > 0) {
        return error.stdout.includes(`"${pid}"`);
      }
      // Probe tool failure (binary missing, timeout, permission denied, FD
      // exhaustion): conservatively assume alive. Breaking a valid lock
      // re-opens the coverage/.tmp race this file exists to prevent. The
      // age-based timeout in isStale() is the backstop for stale locks.
      return true;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function isDirectRun(metaUrl = import.meta.url, argvEntry = process.argv[1]) {
  return typeof argvEntry === 'string' && path.resolve(argvEntry) === fileURLToPath(metaUrl);
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createCoverageLock(options = {}) {
  const command = options.command ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const spawnCommand = options.spawnCommand ?? spawn;
  const openFile = options.openFile ?? openSync;
  const closeFile = options.closeFile ?? closeSync;
  const readFile = options.readFile ?? readFileSync;
  const statFile = options.statFile ?? statSync;
  const unlinkFile = options.unlinkFile ?? unlinkSync;
  const writeFile = options.writeFile ?? writeFileSync;
  const checkProcessAlive = options.checkProcessAlive ?? defaultCheckProcessAlive;
  const onProcess = options.onProcess ?? process.on.bind(process);
  const stderr = options.stderr ?? console.error;
  const lockPath = options.lockPath ?? LOCK_PATH;
  const pollMs = options.pollMs ?? POLL_MS;
  const maxWaitMs =
    options.maxWaitMs ?? Number(env.WRONGSTACK_COVERAGE_LOCK_MAX_WAIT_MS || DEFAULT_MAX_WAIT_MS);
  const sleepFor = options.sleepFor ?? sleep;

  function readOwner() {
    try {
      return readFile(lockPath, 'utf8').trim();
    } catch {
      return '';
    }
  }

  function release() {
    try {
      if (Number(readOwner()) === pid) unlinkFile(lockPath);
    } catch {
      // The lock is already gone, or another process now owns it.
    }
  }

  function isStale() {
    let stat;
    try {
      stat = statFile(lockPath);
    } catch {
      return true;
    }
    if (now() - stat.mtimeMs > maxWaitMs) return true;

    const owner = Number(readOwner());
    if (!Number.isFinite(owner) || owner <= 0) {
      // The owner PID hasn't been written yet — another process just created
      // the lock file and is in the middle of writing. Give it a grace period
      // (two poll cycles) before declaring it stale, otherwise we might delete
      // a brand-new lock and start a concurrent coverage run.
      return now() - stat.mtimeMs > pollMs * 2;
    }

    try {
      return !checkProcessAlive(owner);
    } catch {
      return true;
    }
  }

  async function acquire() {
    let waited = 0;
    let warned = false;

    for (;;) {
      try {
        const fd = openFile(lockPath, 'wx');
        // Keep the descriptor open until the owner has been written. Creating
        // an empty lock and filling it in afterwards lets a concurrent waiter
        // mistake the transient empty file for a stale lock, delete it, and
        // start a second coverage run.
        try {
          writeFile(fd, `${pid}\n`);
        } finally {
          closeFile(fd);
        }
        onProcess('exit', release);
        return;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }

      if (isStale()) {
        try {
          unlinkFile(lockPath);
        } catch {
          // The owner may have released the lock between the stat and unlink.
        }
        continue;
      }

      if (!warned) {
        warned = true;
        stderr(`coverage-lock: waiting for another coverage run (pid ${readOwner()}) to finish…`);
      }

      if (waited >= maxWaitMs) {
        stderr(
          `coverage-lock: gave up waiting after ${Math.round(maxWaitMs / 1000)}s; proceeding (stale owner pid ${readOwner()}).`,
        );
        try {
          unlinkFile(lockPath);
        } catch {
          // A concurrent release is harmless; retry the atomic create.
        }
        continue;
      }

      await sleepFor(pollMs);
      waited += pollMs;
    }
  }

  async function withLock(runner) {
    await acquire();
    try {
      return await runner();
    } finally {
      release();
    }
  }

  function run() {
    return new Promise((resolve) => {
      // String form avoids Node DEP0190 and resolves npm .cmd shims on Windows.
      // Commands come from static package.json scripts, not user input.
      const child = spawnCommand(command.join(' '), {
        stdio: 'inherit',
        shell: true,
        env: { ...env, [HELD_ENV]: '1' },
      });

      for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        onProcess(signal, () => {
          try {
            child.kill(signal);
          } catch {
            // The child may already have exited.
          }
        });
      }

      child.on('error', (error) => {
        stderr('coverage-lock:', error.message);
        resolve(1);
      });
      child.on('exit', (code) => resolve(code ?? 1));
    });
  }

  async function execute() {
    if (command.length === 0) {
      stderr('coverage-lock: no command given (usage: coverage-lock.mjs <cmd> [args...])');
      return 2;
    }

    return env[HELD_ENV] === '1' ? run() : withLock(run);
  }

  return {
    acquire,
    execute,
    isStale,
    readOwner,
    release,
    run,
    withLock,
  };
}

export { defaultCheckProcessAlive };

export function executeCoverageLock(options) {
  return createCoverageLock(options).execute();
}

if (isDirectRun()) {
  process.exit(await executeCoverageLock());
}
