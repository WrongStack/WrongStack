import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SubcommandDeps } from '../src/subcommands/contracts.js';

/**
 * W2 #6: tests for `wstack hq alerts eval` — the dry-run CLI.
 *
 * The handler lives in `packages/cli/src/subcommands/handlers/hq.ts` and is
 * not exported, so we exercise it through the dispatch surface (`hqCmd` →
 * `hqAlertsCmd`) with a mock `SubcommandDeps`. The focus is the eval path
 * because that's where the RFC says we need verification: file-not-found,
 * malformed JSON, rule-fires, and clean-exit when nothing fires.
 */
import { hqCmd } from '../src/subcommands/handlers/hq.js';

function makeDeps(
  dataDir: string,
  snapshotPath?: string,
): SubcommandDeps & {
  stdout: string[];
  stderr: string[];
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const flags: Record<string, string | boolean> = { 'data-dir': dataDir };
  if (snapshotPath !== undefined) flags['snapshot'] = snapshotPath;
  const deps = {
    config: {} as never,
    renderer: {
      write: (line: string) => {
        stdout.push(line);
      },
      writeError: (line: string) => {
        stderr.push(line);
      },
    } as never,
    reader: {} as never,
    args: [] as string[],
    projectRoot: process.cwd(),
    userHome: process.env['USERPROFILE'] ?? process.cwd(),
    flags,
  } as unknown as SubcommandDeps & { stdout: string[]; stderr: string[] };
  // Attach the captured arrays so the test can inspect output.
  Object.defineProperty(deps, 'stdout', { value: stdout, enumerable: false });
  Object.defineProperty(deps, 'stderr', { value: stderr, enumerable: false });
  return deps;
}

let dataDir: string;
let snapshotFile: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'hq-alerts-eval-'));
  snapshotFile = join(dataDir, 'snapshot.json');
});
afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('wstack hq alerts eval (W2 #6)', () => {
  it('exits 0 when no rules fire against a clean snapshot', async () => {
    writeFileSync(
      snapshotFile,
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        clients: [],
        projects: [],
        sessions: [],
        fleets: [],
        mailboxes: [],
        machines: [],
        liveSessions: [],
        totals: { activeProjects: 0, activeClients: 0 },
      }),
      'utf8',
    );
    const deps = makeDeps(dataDir, snapshotFile);
    const code = await hqCmd(['alerts', 'eval'], deps);
    expect(code).toBe(0);
    expect(deps.stdout.join('')).toContain('No alert rules fired');
  });

  it('exits 1 when a rule fires (CI smoke-test contract)', async () => {
    // totalCostUsd=200 exceeds the default costThresholdUsd=50 → fires.
    writeFileSync(
      snapshotFile,
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        clients: [],
        projects: [],
        sessions: [],
        fleets: [],
        mailboxes: [],
        machines: [],
        liveSessions: [],
        totals: { activeProjects: 0, activeClients: 0, totalCostUsd: 200 },
      }),
      'utf8',
    );
    const deps = makeDeps(dataDir, snapshotFile);
    const code = await hqCmd(['alerts', 'eval'], deps);
    expect(code).toBe(1);
    expect(deps.stdout.join('')).toContain('fleet-cost-threshold');
  });

  it('exits 2 when the snapshot file is missing', async () => {
    const deps = makeDeps(dataDir, join(dataDir, 'nonexistent.json'));
    const code = await hqCmd(['alerts', 'eval'], deps);
    expect(code).toBe(2);
    expect(deps.stderr.join('')).toContain('Cannot read snapshot');
  });

  it('exits 2 when the snapshot file is malformed JSON', async () => {
    writeFileSync(snapshotFile, '{ not json', 'utf8');
    const deps = makeDeps(dataDir, snapshotFile);
    const code = await hqCmd(['alerts', 'eval'], deps);
    expect(code).toBe(2);
    expect(deps.stderr.join('')).toContain('not valid JSON');
  });

  it('prints the focused help on --help and exits 0', async () => {
    const deps = makeDeps(dataDir, snapshotFile);
    deps.flags!['help'] = true;
    const code = await hqCmd(['alerts'], deps);
    expect(code).toBe(0);
    expect(deps.stdout.join('')).toContain('wstack hq alerts eval');
  });

  it('returns exit code 1 for an unknown subcommand and prints help', async () => {
    const deps = makeDeps(dataDir, snapshotFile);
    const code = await hqCmd(['alerts', 'bogus'], deps);
    expect(code).toBe(1);
    expect(deps.stderr.join('')).toContain('Unknown hq alerts subcommand');
  });

  it('honors persisted thresholds from alerts-config.json', async () => {
    // Seed alerts-config.json with a high cost threshold (200) so the
    // snapshot's cost of 150 does NOT fire the default rule.
    writeFileSync(
      join(dataDir, 'alerts-config.json'),
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        thresholds: { costThresholdUsd: 200 },
      }),
      'utf8',
    );
    writeFileSync(
      snapshotFile,
      JSON.stringify({
        generatedAt: new Date().toISOString(),
        clients: [],
        projects: [],
        sessions: [],
        fleets: [],
        mailboxes: [],
        machines: [],
        liveSessions: [],
        totals: { activeProjects: 0, activeClients: 0, totalCostUsd: 150 },
      }),
      'utf8',
    );
    const deps = makeDeps(dataDir, snapshotFile);
    const code = await hqCmd(['alerts', 'eval'], deps);
    expect(code).toBe(0);
    expect(deps.stdout.join('')).toContain('No alert rules fired');
  });

  it('strips UTF-8 BOM from snapshot JSON files (F444)', async () => {
    writeFileSync(
      snapshotFile,
      `\uFEFF${JSON.stringify({
        generatedAt: new Date().toISOString(),
        clients: [],
        projects: [],
        sessions: [],
        fleets: [],
        mailboxes: [],
        machines: [],
        liveSessions: [],
        totals: { activeProjects: 0, activeClients: 0, totalCostUsd: 0 },
      })}`,
      'utf8',
    );
    const deps = makeDeps(dataDir, snapshotFile);
    const code = await hqCmd(['alerts', 'eval'], deps);
    expect(code).toBe(0);
    expect(deps.stdout.join('')).toContain('No alert rules fired');
  });
});
