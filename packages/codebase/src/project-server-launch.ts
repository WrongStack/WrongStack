import { spawn } from 'node:child_process';

import * as fs from 'node:fs';

import * as path from 'node:path';

import { daemonSpawnArgs } from '@wrongstack/persistence';

import { removePathSync } from '@wrongstack/primitives';

import { resolveProjectServerUrl } from './project-server-client-state.js';

import {
  PROJECT_INDEX_SERVER_STDERR_MAX_BYTES,
  projectIndexServerMetadataPath,
  projectIndexServerStderrPath,
} from './project-server-endpoint.js';

import type { ProjectIndexServerInfo } from './project-server-protocol.js';

export interface ProjectServerLaunchHost {
  endpoint: string;
  projectRoot: string;
  indexDir: string | undefined;
  info: ProjectIndexServerInfo | null;
  forceKillServer: (pid: number) => boolean;
}
export function spawnDetachedServer(host: ProjectServerLaunchHost): void {
  const url = resolveProjectServerUrl();
  if (!url) throw new Error('built codebase-index project server is unavailable');
  // Unix-domain socket files survive an unclean process death. We only reach
  // this branch after a direct connection attempt failed, so an existing
  // path is stale rather than a live server endpoint.
  if (process.platform !== 'win32') {
    try {
      fs.rmSync(host.endpoint, { force: true });
    } catch {
      /* bind/connect race will elect the winner */
    }
  }
  const args = ['--project-root', host.projectRoot];
  if (host.indexDir) args.push('--index-dir', host.indexDir);
  // Keep stderr. With `stdio: 'ignore'` a daemon that died took its reason
  // with it, and the only thing left was the client's
  // "connection closed" — the symptom, never the cause. Node prints an
  // uncaught exception's stack here before exiting, and V8 prints its fatal
  // heap message here too, which no in-process handler can catch.
  let stderrTarget: number | 'ignore' = 'ignore';
  try {
    const logPath = projectIndexServerStderrPath(host.projectRoot, host.indexDir);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    // Truncate a log that has already grown past the cap rather than
    // appending forever: a crash-looping daemon must not fill the disk, and
    // only the most recent death is diagnostically useful.
    try {
      if (fs.statSync(logPath).size > PROJECT_INDEX_SERVER_STDERR_MAX_BYTES) {
        fs.truncateSync(logPath, 0);
      }
    } catch {
      /* absent is the normal case */
    }
    stderrTarget = fs.openSync(logPath, 'a');
  } catch {
    // A read-only or missing index dir must not stop the daemon starting;
    // losing the log is worse than today, not fatal.
    stderrTarget = 'ignore';
  }
  const child = spawn(process.execPath, daemonSpawnArgs(url, args), {
    detached: true,
    stdio: ['ignore', 'ignore', stderrTarget],
    windowsHide: true,
    env: process.env,
  });
  if (typeof stderrTarget === 'number') {
    // The child holds its own duplicate of the descriptor; ours would keep
    // the file open for the life of this process.
    try {
      fs.closeSync(stderrTarget);
    } catch {
      /* already closed */
    }
  }
  child.unref();
}

export function forceKillKnownServer(host: ProjectServerLaunchHost): boolean {
  const pid = host.info?.pid;
  return pid ? host.forceKillServer(pid) : false;
}

export function forceKillServer(host: ProjectServerLaunchHost, pid: number): boolean {
  if (pid === process.pid) return false;
  try {
    process.kill(pid);
    const metadataPath = projectIndexServerMetadataPath(host.projectRoot, host.indexDir);
    try {
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as { pid?: number };
      if (metadata.pid === pid) removePathSync(metadataPath, { force: true });
    } catch {
      /* absent or already replaced */
    }
    return true;
  } catch {
    return false;
  }
}
