/**
 * Chimera and auto-review list changed files from `git status --porcelain`.
 * Line output C-quotes names with spaces or non-ASCII bytes (`"my notes.ts"`,
 * `"\305\237ema.ts"`) and folds a new directory into one `?? dir/` entry; the
 * quoted/directory path then failed fs.access/readFile and the file silently
 * dropped out of the review. Real git, real plugin handler.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel/events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getChangedFiles, snapshotChangedFiles } from '../../src/plugins/auto-review-git.js';
import { createChimeraPlugin } from '../../src/plugins/chimera-plugin.js';

let tmp: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'core.quotePath=true', ...args], { cwd: tmp });

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'review-quoted-'));
  git('init', '-q');
  git('config', 'user.email', 't@e.com');
  git('config', 'user.name', 'tester');
  git('config', 'core.autocrlf', 'false');
  for (const name of ['plain.ts', 'my notes.ts', 'şema.ts', 'old name.ts']) {
    await fs.writeFile(path.join(tmp, name), 'v1');
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  for (const name of ['plain.ts', 'my notes.ts', 'şema.ts']) {
    await fs.writeFile(path.join(tmp, name), 'v2');
  }
  git('mv', 'old name.ts', 'new name.ts');
  await fs.writeFile(path.join(tmp, 'new file.ts'), 'n');
  await fs.mkdir(path.join(tmp, 'feature'));
  await fs.writeFile(path.join(tmp, 'feature', 'impl.ts'), 'n');
});

afterEach(async () => {
  // The claim ledger may still hold a SQLite handle on Windows.
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
});

describe('changed-file listing with quoted paths', () => {
  it('chimera reviews files with spaces, non-ASCII names and inside new directories', async () => {
    const bus = new EventBus();
    const handlers: Record<string, () => Promise<void>> = {};
    const emitCustom = vi.fn((event: string, payload: unknown) => bus.emitCustom(event, payload));
    const api = {
      config: { provider: 'anthropic', model: 'claude', cwd: tmp },
      events: bus,
      onConfigChange: () => undefined,
      onEvent: (type: string, handler: () => Promise<void>) => {
        handlers[type] = handler;
      },
      onPattern: (pattern: string, handler: (event: string, payload: unknown) => void) =>
        bus.onPattern(pattern, handler),
      emitCustom,
      slashCommands: { register: () => undefined, unregister: () => undefined },
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as never;
    createChimeraPlugin().setup!(api);
    await handlers['session.ended']!();

    const payload = emitCustom.mock.calls.find(([e]) => e === 'chimera.review_needed')?.[1] as {
      files: Array<{ path: string; status: string; content: string }>;
    };
    expect(payload.files.map((f) => `${f.status}:${f.path}`).sort()).toEqual([
      'added:feature/impl.ts',
      'added:new file.ts',
      'modified:my notes.ts',
      'modified:plain.ts',
      'modified:şema.ts',
    ]);
    expect(payload.files.find((f) => f.path === 'şema.ts')?.content).toBe('v2');
  });

  it('auto-review lists real paths and snapshots their content', async () => {
    expect((await getChangedFiles(tmp)).map((f) => `${f.status}:${f.path}`).sort()).toEqual([
      'modified:my notes.ts',
      'modified:new name.ts',
      'modified:plain.ts',
      'modified:şema.ts',
    ]);
    expect((await snapshotChangedFiles(tmp)).map((f) => f.path).sort()).toEqual([
      'my notes.ts',
      'new name.ts',
      'plain.ts',
      'şema.ts',
    ]);
  });
});
