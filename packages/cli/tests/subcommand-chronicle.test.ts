import { beforeEach, describe, expect, it, vi } from 'vitest';

const call = vi.fn();
const close = vi.fn();

vi.mock('@wrongstack/core/chronicle', () => ({
  createChronicleProjectAccess: () => ({ call, close }),
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
