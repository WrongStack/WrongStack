import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import type { EventBus } from '@wrongstack/contracts/kernel';
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
// The git isolation lookup runs its own `git config`; the review flow is what
// is under test, so the lookup answers "nothing to blank".
vi.mock('@wrongstack/primitives', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/primitives')>()),
  gitIsolationEnv: async () => ({}),
}));

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
 * Create a fake child process that writes the given chunks then closes.
 * Real streams (not bare emitters), so the command's decoding runs as it does
 * against git: a Buffer chunk may end mid-character.
 */
function fakeChild(
  stdoutChunks: Array<string | Buffer>,
  exitCode = 0,
): EventEmitter & { stdout: PassThrough; stderr: PassThrough } {
  const child = new EventEmitter() as EventEmitter & {
    stdout: PassThrough;
    stderr: PassThrough;
  };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  // Schedule async emission
  setImmediate(() => {
    child.stdout.on('end', () => child.emit('close', exitCode));
    for (const chunk of stdoutChunks) {
      child.stdout.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    child.stdout.end();
  });
  return child;
}

/**
 * Answer `git status` with `child`; `git rev-parse --show-prefix` answers the
 * repository root (empty prefix) with a fresh child of its own.
 */
function gitStatusReturns(child: unknown): void {
  mockSpawn.mockImplementation((_bin: string, args: string[]) =>
    args[0] === 'rev-parse' ? fakeChild([''], 0) : child,
  );
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
    gitStatusReturns(fakeChild([''], 0));
    const cmd = buildReviewCommand(makeOpts());
    const res = await cmd.run('', { cwd } as never);
    expect(res?.message).toMatch(/No changed files/);
  });

  it('returns no-changed-files when git status has only .wrongstack/', async () => {
    gitStatusReturns(fakeChild(['M  .wrongstack/config.json\0'], 0));
    const cmd = buildReviewCommand(makeOpts());
    const res = await cmd.run('', { cwd } as never);
    expect(res?.message).toMatch(/No changed files/);
  });

  it('returns no-matching-files when file filter yields nothing', async () => {
    gitStatusReturns(fakeChild(['M  src/foo.ts\0'], 0));
    mockAccess.mockRejectedValue(new Error('not found'));
    const cmd = buildReviewCommand(makeOpts());
    const res = await cmd.run('--files nonexistent', { cwd } as never);
    expect(res?.message).toContain('nonexistent');
  });

  it('triggers chimera review for changed files', async () => {
    gitStatusReturns(fakeChild(['M  src/foo.ts\0'], 0));
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
    gitStatusReturns(fakeChild(['M  src/bar.ts\0M  src/foo.ts\0'], 0));
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
    const files = Array.from({ length: 5 }, (_, i) => `M  src/file${i}.ts\0`).join('');
    gitStatusReturns(fakeChild([files], 0));
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
    gitStatusReturns(fakeChild([''], 1));
    const cmd = buildReviewCommand(makeOpts());
    const res = await cmd.run('', { cwd } as never);
    expect(res?.message).toMatch(/No changed files/);
  });

  it('handles spawn error gracefully', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    setImmediate(() => child.emit('error', new Error('ENOENT')));
    gitStatusReturns(child);

    const cmd = buildReviewCommand(makeOpts());
    const res = await cmd.run('', { cwd } as never);
    expect(res?.message).toMatch(/No changed files/);
  });
});

// Line porcelain C-quotes names with spaces/non-ASCII bytes and folds a new
// directory into one `?? dir/` entry; those files failed fs.access and were
// silently left out of the review.
describe('buildReviewCommand changed-file listing', () => {
  // `stdout += chunk` decoded each Buffer on its own: a 2-byte character split
  // at a pipe-chunk boundary became U+FFFD U+FFFD and the file was skipped.
  it('keeps a multibyte name intact when a chunk boundary splits it', async () => {
    const record = Buffer.from(' M şema.ts\0');
    const cut = record.indexOf(0xc5) + 1; // between the two bytes of `ş`
    gitStatusReturns(fakeChild([record.subarray(0, cut), record.subarray(cut)], 0));
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue('content');

    const emitCustom = vi.fn();
    const cmd = buildReviewCommand(makeOpts({ events: { emitCustom } as never }));
    await cmd.run('', { cwd, provider: { id: 'test' }, model: 'm1' } as never);

    expect(mockAccess).toHaveBeenCalledWith(path.join(cwd, 'şema.ts'));
  });

  it('asks git for NUL records with every untracked file and skips rename sources', async () => {
    gitStatusReturns(
      fakeChild(
        [
          ' M my notes.ts\u0000 M şema.ts\u0000?? feature/impl.ts\u0000' +
            'RM new name.ts\u0000old name.ts\u0000 D gone.ts\u0000',
        ],
        0,
      ),
    );
    mockAccess.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue('content');

    const emitCustom = vi.fn();
    const cmd = buildReviewCommand(makeOpts({ events: { emitCustom } as never }));
    await cmd.run('', { cwd, provider: { id: 'test' }, model: 'm1' } as never);

    expect(mockSpawn.mock.calls[0]?.[1]).toEqual([
      'status',
      '--porcelain',
      '-z',
      '--untracked-files=all',
    ]);
    const payload = emitCustom.mock.calls.find(([e]) => e === 'chimera.review_needed')?.[1] as {
      files: Array<{ path: string; status: string }>;
    };
    expect(payload.files.map((f) => `${f.status}:${f.path}`)).toEqual([
      'modified:my notes.ts',
      'modified:şema.ts',
      'added:feature/impl.ts',
      'modified:new name.ts',
    ]);
  });
});
