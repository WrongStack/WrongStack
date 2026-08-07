import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  call,
  close,
  createChronicleProjectAccess,
  compactChronicleSqlite,
  resolveChronicleProjectServerOptions,
  chronicleProjectServerMetadataPath,
} = vi.hoisted(() => {
  const hoistedCall = vi.fn();
  const hoistedClose = vi.fn();
  return {
    call: hoistedCall,
    close: hoistedClose,
    createChronicleProjectAccess: vi.fn(() => ({ call: hoistedCall, close: hoistedClose })),
    compactChronicleSqlite: vi.fn(),
    resolveChronicleProjectServerOptions: vi.fn(() => ({ projectDir: '/runtime/project' })),
    chronicleProjectServerMetadataPath: vi.fn(
      (projectDir: string) => `${projectDir}/chronicle/server.json`,
    ),
  };
});

vi.mock('@wrongstack/core/chronicle', () => ({
  chronicleProjectServerMetadataPath,
  compactChronicleSqlite,
  createChronicleProjectAccess,
  resolveChronicleProjectServerOptions,
}));

import { parseArgs } from '../src/arg-parser.js';
import { chronicleCmd } from '../src/subcommands/handlers/chronicle.js';

function fakeDeps(flags: Record<string, string | boolean> = {}) {
  return {
    config: {},
    renderer: { write: vi.fn(), writeError: vi.fn(), writeInfo: vi.fn(), writeWarning: vi.fn() },
    reader: { readLine: vi.fn() },
    cwd: '/tmp',
    projectRoot: '/tmp',
    userHome: '/tmp',
    flags,
  } as never as Parameters<typeof chronicleCmd>[1];
}

/**
 * Drive the REAL dispatch path.
 *
 * `parseArgs` pulls every `--flag` out of argv and `boot.ts:358` hands the
 * handler only `positional.slice(1)`. Every existing handler test hand-builds
 * an `args` array still containing those tokens — i.e. a shape the dispatcher
 * can never produce — which is why this class of bug survived the whole suite.
 */
async function dispatch(argv: string[]): Promise<void> {
  const { flags, positional } = parseArgs(argv);
  await chronicleCmd(positional.slice(1), fakeDeps(flags));
}

beforeEach(() => {
  call.mockReset();
  call.mockResolvedValue({ candidates: [], deleted: 0 });
  close.mockReset();
  createChronicleProjectAccess.mockClear();
  compactChronicleSqlite.mockReset();
  compactChronicleSqlite.mockReturnValue({ beforeBytes: 200, afterBytes: 120, reclaimedBytes: 80 });
  resolveChronicleProjectServerOptions.mockClear();
  chronicleProjectServerMetadataPath.mockClear();
});

describe('chronicle prune — flags must survive the dispatcher', () => {
  // The form printed in this command's own usage text. Scanning `args` alone
  // saw neither flag, so it resolved to `dryRun:false, retentionDays:30` and
  // permanently deleted every entry older than 30 days — exit 0, while the
  // user believed they were previewing a 7-day prune.
  it('honours --dry-run and --days through parseArgs', async () => {
    await dispatch(['chronicle', 'prune', '--days', '7', '--dry-run']);

    expect(call).toHaveBeenCalledWith('purge', { retentionDays: 7, dryRun: true });
  });

  it('honours --dry-run when it precedes --days', async () => {
    await dispatch(['chronicle', 'prune', '--dry-run', '--days', '7']);

    expect(call).toHaveBeenCalledWith('purge', { retentionDays: 7, dryRun: true });
  });

  it('honours the -n short form', async () => {
    await dispatch(['chronicle', 'prune', '-n']);

    expect(call).toHaveBeenCalledWith('purge', { retentionDays: 30, dryRun: true });
  });

  it('still performs a real purge when no flag is given', async () => {
    await dispatch(['chronicle', 'prune']);

    expect(call).toHaveBeenCalledWith('purge', { retentionDays: 30, dryRun: false });
  });

  // `--dry-run` was absent from BOOLEAN_FLAGS, so parseArgs consumed the next
  // positional as its value — on the one command whose purpose is to not delete.
  it('does not swallow a following positional', () => {
    const { flags, positional } = parseArgs(['chronicle', 'prune', '--dry-run', 'extra']);
    expect(flags['dry-run']).toBe(true);
    expect(positional).toEqual(['chronicle', 'prune', 'extra']);
  });
});

describe('chronicle compact', () => {
  it('uses canonical offline paths without creating project access', async () => {
    await expect(dispatch(['chronicle', 'compact'])).resolves.toBeUndefined();

    expect(resolveChronicleProjectServerOptions).toHaveBeenCalledWith({
      projectRoot: '/tmp',
      userHome: '/tmp',
    });
    expect(chronicleProjectServerMetadataPath).toHaveBeenCalledWith('/runtime/project');
    expect(compactChronicleSqlite).toHaveBeenCalledWith({
      dbPath: path.join('/runtime/project', 'chronicle', 'chronicle.sqlite'),
      endpointMetadataPath: '/runtime/project/chronicle/server.json',
    });
    expect(createChronicleProjectAccess).not.toHaveBeenCalled();
  });

  it('rejects unexpected positional arguments before touching storage', async () => {
    const deps = fakeDeps();

    await chronicleCmd(['compact', 'extra'], deps);

    expect(deps.renderer.writeError).toHaveBeenCalledWith(
      expect.stringContaining('Usage: wstack chronicle compact'),
    );
    expect(compactChronicleSqlite).not.toHaveBeenCalled();
    expect(createChronicleProjectAccess).not.toHaveBeenCalled();
  });
});
