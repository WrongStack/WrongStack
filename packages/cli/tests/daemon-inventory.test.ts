/**
 * `wstack doctor --daemons` reads project IPC state. The property under test
 * throughout is that reading never writes: listing daemons must not spawn one,
 * and clearing must only ever unlink an endpoint a probe just called dead.
 */
import { mkdtempSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { chronicleProjectServerMetadataPath } from '@wrongstack/core/chronicle';
import { KANBAN_PROJECT_SERVER_METADATA_FILE } from '@wrongstack/kanban';
import { sageProjectServerMetadataPath } from '@wrongstack/sage';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearStaleDaemonEndpoints,
  collectDaemonReports,
} from '../src/subcommands/handlers/daemon-inventory.js';

// Liveness is the one thing a unit test cannot observe honestly — a real probe
// would need a real daemon. Everything else (endpoint derivation, metadata
// reads, unlinking) runs against a throwaway project on disk.
const { liveEndpoints } = vi.hoisted(() => ({ liveEndpoints: new Set<string>() }));

vi.mock('@wrongstack/persistence', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/persistence')>()),
  isProjectEndpointLive: vi.fn(async (endpoint: string) => liveEndpoints.has(endpoint)),
}));

/** Windows named pipes have no filesystem entry, so "stale" cannot occur. */
const namedPipes = process.platform === 'win32';

let inventory: { projectRoot: string; projectDir: string };

beforeEach(() => {
  liveEndpoints.clear();
  // A fresh project root per test keeps derived endpoints unique, so a real
  // daemon for the actual repo can never be probed — let alone unlinked.
  const root = mkdtempSync(path.join(tmpdir(), 'ws-daemon-inv-'));
  inventory = { projectRoot: path.join(root, 'repo'), projectDir: path.join(root, 'state') };
});

describe('collectDaemonReports', () => {
  it('reports every project daemon as stopped before any has run', async () => {
    const reports = await collectDaemonReports(inventory);

    expect(reports.map((report) => report.name)).toEqual([
      'kanban',
      'sage',
      'chronicle',
      'mailbox',
      'session-catalog',
      'codebase-index',
    ]);
    expect(reports.every((report) => report.status === 'stopped')).toBe(true);
    expect(reports.every((report) => report.pid === undefined)).toBe(true);
    // Each daemon owns a distinct endpoint; a collision would mean two daemons
    // electing each other's owner.
    expect(new Set(reports.map((report) => report.endpoint)).size).toBe(reports.length);
  });

  it('omits governance, which has its own richer inspection path', async () => {
    const reports = await collectDaemonReports(inventory);

    expect(reports.some((report) => report.name === 'governance')).toBe(false);
  });

  it('never creates the project directories it probes', async () => {
    await collectDaemonReports(inventory);

    await expect(fs.stat(inventory.projectRoot)).rejects.toThrow();
    await expect(fs.stat(inventory.projectDir)).rejects.toThrow();
  });

  it('reads each live daemon pid from its own metadata file', async () => {
    const metadata: readonly (readonly [string, number])[] = [
      // Kanban is the exception: its server file sits next to the boards it
      // owns, in-repo, not under the global per-project state directory.
      [path.join(inventory.projectRoot, '.wrongstack', KANBAN_PROJECT_SERVER_METADATA_FILE), 4242],
      [sageProjectServerMetadataPath(inventory.projectRoot), 77],
    ];
    for (const [file, pid] of metadata) {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify({ pid }));
    }
    // Unreadable metadata must not fail the report: the pid is a convenience.
    const chronicleMetadata = chronicleProjectServerMetadataPath(inventory.projectDir);
    await fs.mkdir(path.dirname(chronicleMetadata), { recursive: true });
    await fs.writeFile(chronicleMetadata, 'not json');
    for (const report of await collectDaemonReports(inventory)) {
      liveEndpoints.add(report.endpoint);
    }

    const reports = await collectDaemonReports(inventory);

    expect(reports.every((report) => report.status === 'live')).toBe(true);
    const pids = Object.fromEntries(reports.map((report) => [report.name, report.pid]));
    expect(pids.kanban).toBe(4242);
    expect(pids.sage).toBe(77);
    expect(pids.chronicle).toBeUndefined();
    // A daemon with no metadata file on disk still reports live.
    expect(pids.mailbox).toBeUndefined();
  });

  it('never reads a pid for a daemon that is not answering', async () => {
    const sageMetadata = sageProjectServerMetadataPath(inventory.projectRoot);
    await fs.mkdir(path.dirname(sageMetadata), { recursive: true });
    await fs.writeFile(sageMetadata, JSON.stringify({ pid: 999 }));

    const reports = await collectDaemonReports(inventory);

    // The metadata outlives the daemon, so a pid here would name a dead
    // process — or worse, one whose id has been recycled.
    expect(reports.find((report) => report.name === 'sage')?.pid).toBeUndefined();
  });
});

describe('clearStaleDaemonEndpoints', () => {
  it('clears an endpoint left behind by a dead daemon', async () => {
    const before = await collectDaemonReports(inventory);
    if (namedPipes) {
      // Nothing to clear: a pipe vanishes with the process holding it, so an
      // unanswered pipe is always stopped, never wedged.
      expect(before.every((report) => report.status === 'stopped')).toBe(true);
      expect(await clearStaleDaemonEndpoints(inventory)).toEqual([]);
      return;
    }
    for (const report of before) {
      await fs.mkdir(path.dirname(report.endpoint), { recursive: true });
      await fs.writeFile(report.endpoint, '');
    }

    const staleReports = await collectDaemonReports(inventory);
    const cleared = await clearStaleDaemonEndpoints(inventory);
    const after = await collectDaemonReports(inventory);

    expect(staleReports.every((report) => report.status === 'stale')).toBe(true);
    expect([...cleared].sort()).toEqual(before.map((report) => report.name).sort());
    expect(after.every((report) => report.status === 'stopped')).toBe(true);
  });

  it('leaves a live daemon endpoint alone', async () => {
    if (namedPipes) {
      expect(await clearStaleDaemonEndpoints(inventory)).toEqual([]);
      return;
    }
    for (const report of await collectDaemonReports(inventory)) {
      await fs.mkdir(path.dirname(report.endpoint), { recursive: true });
      await fs.writeFile(report.endpoint, '');
      liveEndpoints.add(report.endpoint);
    }

    const cleared = await clearStaleDaemonEndpoints(inventory);
    const after = await collectDaemonReports(inventory);

    // Unlinking a live socket severs every connected client and elects a
    // second writer over the same database.
    expect(cleared).toEqual([]);
    expect(after.every((report) => report.status === 'live')).toBe(true);
  });

  it('keeps reporting an endpoint it could not remove', async () => {
    if (namedPipes) {
      expect(await clearStaleDaemonEndpoints(inventory)).toEqual([]);
      return;
    }
    const [wedged, ...removable] = await collectDaemonReports(inventory);
    for (const report of removable) {
      await fs.mkdir(path.dirname(report.endpoint), { recursive: true });
      await fs.writeFile(report.endpoint, '');
    }
    // A directory where a socket belongs cannot be unlinked, which stands in
    // for any unlink the operator's filesystem refuses.
    await fs.mkdir(wedged?.endpoint ?? '', { recursive: true });

    const cleared = await clearStaleDaemonEndpoints(inventory);
    const after = await collectDaemonReports(inventory);

    expect(cleared).not.toContain(wedged?.name);
    expect(cleared).toHaveLength(removable.length);
    // Still named in the report, so the operator can act on it by hand.
    expect(after.find((report) => report.name === wedged?.name)?.status).toBe('stale');
  });
});
