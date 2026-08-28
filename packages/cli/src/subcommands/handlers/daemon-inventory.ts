/**
 * Inventory of this project's IPC daemons.
 *
 * Project daemons are deliberately invisible: they are spawned on demand,
 * shared by every surface (TUI, WebUI, HQ, fleet agents, MCP), and idle out on
 * their own. That is the right default — a healthy daemon is not the user's
 * problem — but it left no way to answer the two questions an operator
 * actually has when something is wrong: which of them are running, and is any
 * of them wedged.
 *
 * This module answers both without starting anything. Every endpoint helper
 * here is a pure derivation from the project path, and liveness is a connect
 * probe, so listing daemons never spawns one as a side effect. That property
 * is load-bearing: a diagnostic that resurrects the subsystem it is measuring
 * cannot report on it.
 *
 * `governance` is intentionally absent. It is opt-in per project and carries
 * its own richer inspection path (`inspectGovernanceDaemon`, which reasons
 * about startup leases and metadata ownership); flattening it into this table
 * would report less than `wstack governance status` already does.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  chronicleProjectServerEndpoint,
  chronicleProjectServerMetadataPath,
} from '@wrongstack/core/chronicle';
import {
  mailboxProjectServerEndpoint,
  mailboxProjectServerMetadataPath,
} from '@wrongstack/core/coordination';
import {
  sessionCatalogProjectServerEndpoint,
  sessionCatalogProjectServerMetadataPath,
} from '@wrongstack/core/session-catalog';
import {
  KANBAN_PROJECT_SERVER_METADATA_FILE,
  kanbanProjectServerEndpoint,
} from '@wrongstack/kanban';
import { isProjectEndpointLive } from '@wrongstack/persistence';
import { sageProjectServerEndpoint, sageProjectServerMetadataPath } from '@wrongstack/sage';
import {
  projectIndexServerEndpoint,
  projectIndexServerMetadataPath,
} from '@wrongstack/tools/codebase-index';

/** Where a daemon's derived endpoint and metadata live for this project. */
interface DaemonDescriptor {
  readonly name: string;
  readonly endpoint: string;
  /** Owner-only JSON holding at least `pid`, when the daemon writes one. */
  readonly metadataPath?: string;
}

type DaemonStatus =
  /** Answering on its endpoint. */
  | 'live'
  /**
   * The endpoint exists on disk but nothing answers on it. This is the wedge:
   * clients get ECONNREFUSED and conclude "spawn one", the replacement gets
   * EADDRINUSE from the leftover file. Self-healing daemons reclaim it on
   * their next start; seeing this means one has not been started since.
   */
  | 'stale'
  /** No endpoint and no daemon. The normal state before first use. */
  | 'stopped';

export interface DaemonReport {
  readonly name: string;
  readonly endpoint: string;
  readonly status: DaemonStatus;
  /** Owning process id, when a metadata file was readable. */
  readonly pid?: number;
}

interface DaemonInventoryOptions {
  readonly projectRoot: string;
  /**
   * The project's slot under the global root — `~/.wrongstack/projects/<hash>`,
   * NOT the in-repo `.wrongstack/`. Most daemons key their endpoint and
   * metadata off this; kanban is the exception and uses the repo directory.
   */
  readonly projectDir: string;
}

function describeDaemons(options: DaemonInventoryOptions): readonly DaemonDescriptor[] {
  const { projectRoot, projectDir } = options;
  return [
    {
      name: 'kanban',
      // In-repo `<projectRoot>/.wrongstack/`, not the global per-project state
      // directory the other daemons use. Kanban deliberately keeps its server
      // file next to the boards it owns.
      metadataPath: path.join(projectRoot, '.wrongstack', KANBAN_PROJECT_SERVER_METADATA_FILE),
      endpoint: kanbanProjectServerEndpoint(projectRoot),
    },
    {
      name: 'sage',
      endpoint: sageProjectServerEndpoint(projectRoot),
      metadataPath: sageProjectServerMetadataPath(projectRoot),
    },
    {
      name: 'chronicle',
      endpoint: chronicleProjectServerEndpoint(projectDir),
      metadataPath: chronicleProjectServerMetadataPath(projectDir),
    },
    {
      name: 'mailbox',
      endpoint: mailboxProjectServerEndpoint(projectDir),
      metadataPath: mailboxProjectServerMetadataPath(projectDir),
    },
    {
      name: 'session-catalog',
      endpoint: sessionCatalogProjectServerEndpoint(projectDir),
      metadataPath: sessionCatalogProjectServerMetadataPath(projectDir),
    },
    {
      name: 'codebase-index',
      endpoint: projectIndexServerEndpoint(projectRoot),
      metadataPath: projectIndexServerMetadataPath(projectRoot),
    },
  ];
}

async function readPid(metadataPath: string | undefined): Promise<number | undefined> {
  if (!metadataPath) return undefined;
  try {
    const parsed = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as { pid?: unknown };
    return typeof parsed.pid === 'number' ? parsed.pid : undefined;
  } catch {
    // Absent or unreadable metadata is not a fault: the pid is a convenience,
    // and the endpoint probe is what determines status.
    return undefined;
  }
}

async function endpointExists(endpoint: string): Promise<boolean> {
  // A Windows named pipe has no filesystem entry, so "exists on disk but dead"
  // is not a state it can be in — a pipe vanishes with the process holding it.
  // Absence of a live answer there always means stopped, never stale.
  if (process.platform === 'win32') return false;
  try {
    await fs.stat(endpoint);
    return true;
  } catch {
    return false;
  }
}

/** Probe every project daemon concurrently. Never spawns one. */
export async function collectDaemonReports(
  options: DaemonInventoryOptions,
): Promise<readonly DaemonReport[]> {
  return Promise.all(
    describeDaemons(options).map(async (descriptor): Promise<DaemonReport> => {
      const live = await isProjectEndpointLive(descriptor.endpoint);
      const status: DaemonStatus = live
        ? 'live'
        : (await endpointExists(descriptor.endpoint))
          ? 'stale'
          : 'stopped';
      const pid = live ? await readPid(descriptor.metadataPath) : undefined;
      return pid === undefined
        ? { name: descriptor.name, endpoint: descriptor.endpoint, status }
        : { name: descriptor.name, endpoint: descriptor.endpoint, status, pid };
    }),
  );
}

/**
 * Delete stale endpoints so the next client spawn can bind.
 *
 * Only ever removes an endpoint that a fresh probe just reported as stale —
 * unlinking a live daemon's socket would sever every connected client and
 * elect a second writer over the same database. Restarting is therefore not
 * an operation this offers: daemons are spawned on demand, so clearing the
 * wedge is the whole job, and the next command that needs one starts it.
 */
export async function clearStaleDaemonEndpoints(
  options: DaemonInventoryOptions,
): Promise<readonly string[]> {
  const cleared: string[] = [];
  for (const report of await collectDaemonReports(options)) {
    if (report.status !== 'stale') continue;
    try {
      await fs.rm(report.endpoint, { force: true });
      cleared.push(report.name);
    } catch {
      // Left in place; the report still names it so the operator can act.
    }
  }
  return cleared;
}
