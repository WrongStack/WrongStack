import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { EventBus } from '@wrongstack/core/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { buildReviewCommand } from '../src/slash-commands/review.js';

// vi.mock is hoisted to top-of-file, so we use vi.hoisted to define mocks early
const { mockSpawn, mockAccess, mockReadFile } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockAccess: vi.fn(),
  mockReadFile: vi.fn(),
}));

vi.mock('node:child_process', () => {
  return { spawn: mockSpawn };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access: mockAccess,
    readFile: mockReadFile,
  };
});

/**
 * Per-test working tree. `emitReviewIfChanged` writes a REAL claim ledger at
 * `<cwd>/.wrongstack/review-claims.jsonl` guarded by a host:pid lock; sharing
 * one literal cwd put these tests through the 5s + 30s claim-lock retry ladder
 * against every other run's leftover locks and 30-min-TTL claims.
 */
let cwd: string;

beforeEach(async () => {
  mockSpawn.mockReset();
  mockAccess.mockReset();
  mockReadFile.mockReset();
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-slash-review-'));
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

/**
 * Create a fake child process that emits the given chunks then closes.
 */
function fakeChild(
  stdoutChunks: string[],
  exitCode = 0,
): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  // Schedule async emission
  setImmediate(() => {
    for (const chunk of stdoutChunks) {
      child.stdout.emit('data', Buffer.from(chunk));
    }
    child.emit('close', exitCode);
  });
  return child;
}

function makeOpts(overrides: Partial<SlashCommandContext> = {}): SlashCommandContext {
  const events = {
    emitCustom: vi.fn(),
  } as never as EventBus;
  return {
    events,
    ...overrides,
  } as never as SlashCommandContext;
}

describe('buildReviewCommand', () => {
  it('returns no-changed-files when git status is empty', async () => {
    mockSpawn.mockReturnValue(fakeChild([''], 0));
    const cmd = buildReviewCommand(makeOpts());
    const res = await cmd.run('', { cwd } as never);
    expect(res?.message).toMatch(/No changed files/);
  });

  it('returns no-changed-files when git status has only .wrongstack/', async () => {
    mockSpawn.mockReturnValue(fakeChild(['M  .wrongstack/config.json\n'], 0));
    const cmd = buildReviewCommand(makeOpts());
    const res = await cmd.run('', { cwd } as never);
    expect(res?.message).toMatch(/No changed files/);
  });

  it('returns no-matching-files when file filter yields nothing', async () => {
    mockSpawn.mockReturnValue(fakeChild(['M  src/foo.ts\n'], 0));
    mockAccess.mockRejectedValue(new Error('not found'));
    const cmd = buildReviewCommand(makeOpts());
    const res = await cmd.run('--files nonexistent', { cwd } as never);
    expect(res?.message).toContain('nonexistent');
  });

  it('triggers chimera review for changed files', async () => {
    mockSpawn.mockReturnValue(fakeChild(['M  src/foo.ts\n'], 0));
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue('content of foo.ts');

    const emitCustom = vi.fn();
    const cmd = buildReviewCommand(makeOpts({ events: { emitCustom } as never }));
    const res = await cmd.run('', {
      cwd,
      provider: { id: 'test' },
      model: 'm1',
    } as never);

    expect(res?.message).toContain('Chimera review triggered');
    expect(res?.message).toContain('1 file(s)');
    expect(emitCustom).toHaveBeenCalledWith(
      'chimera.review_needed',
      expect.objectContaining({
        cwd,
        files: expect.arrayContaining([
          expect.objectContaining({
            path: 'src/foo.ts',
            status: 'modified',
            content: 'content of foo.ts',
          }),
        ]),
      }),
    );
  });

  it('filters files by --files substring', async () => {
    mockSpawn.mockReturnValue(fakeChild(['M  src/bar.ts\nM  src/foo.ts\n'], 0));
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue('content');

    const emitCustom = vi.fn();
    const cmd = buildReviewCommand(makeOpts({ events: { emitCustom } as never }));
    const res = await cmd.run('--files foo', {
      cwd,
      provider: { id: 'test' },
      model: 'm1',
    } as never);

    expect(res?.message).toContain('1 file(s)');
    expect(emitCustom).toHaveBeenCalledWith(
      'chimera.review_needed',
      expect.objectContaining({
        files: expect.arrayContaining([expect.objectContaining({ path: 'src/foo.ts' })]),
      }),
    );
  });

  it('respects --limit flag', async () => {
    const files = Array.from({ length: 5 }, (_, i) => `M  src/file${i}.ts\n`).join('');
    mockSpawn.mockReturnValue(fakeChild([files], 0));
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue('content');

    const emitCustom = vi.fn();
    const cmd = buildReviewCommand(makeOpts({ events: { emitCustom } as never }));
    const res = await cmd.run('--limit 2', {
      cwd,
      provider: { id: 'test' },
      model: 'm1',
    } as never);

    expect(res?.message).toContain('2 file(s)');
    expect(res?.message).toContain('3 more changed file(s)');
    expect(emitCustom).toHaveBeenCalledWith(
      'chimera.review_needed',
      expect.objectContaining({
        config: expect.objectContaining({ maxFiles: 2 }),
      }),
    );
  });

  it('handles git error gracefully', async () => {
    mockSpawn.mockReturnValue(fakeChild([''], 1));
    const cmd = buildReviewCommand(makeOpts());
    const res = await cmd.run('', { cwd } as never);
    expect(res?.message).toMatch(/No changed files/);
  });

  it('handles spawn error gracefully', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => child.emit('error', new Error('ENOENT')));
    mockSpawn.mockReturnValue(child);

    const cmd = buildReviewCommand(makeOpts());
    const res = await cmd.run('', { cwd } as never);
    expect(res?.message).toMatch(/No changed files/);
  });
});
