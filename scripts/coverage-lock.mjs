#!/usr/bin/env node
// Serializes concurrent coverage runs so they cannot corrupt each other's
// coverage/.tmp directory.
//
// Vitest coverage providers write intermediate files below coverage/.tmp. A
// second run can clean that directory while the first run is still reading it,
// so every repository coverage command is routed through this lock.

import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCK_PATH = path.join(REPO_ROOT, '.coverage.lock');
const HELD_ENV = 'WRONGSTACK_COVERAGE_LOCK_HELD';
const POLL_MS = 1000;
const DEFAULT_MAX_WAIT_MS = 60 * 60 * 1000;

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
  const signalProcess = options.signalProcess ?? process.kill.bind(process);
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
    if (!Number.isFinite(owner) || owner <= 0) return true;

    try {
      signalProcess(owner, 0);
      return false;
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
        closeFile(fd);
        writeFile(lockPath, `${pid}\n`);
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

export function executeCoverageLock(options) {
  return createCoverageLock(options).execute();
}

if (isDirectRun()) {
  process.exit(await executeCoverageLock());
}
