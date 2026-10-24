/**
 * The review / commit-safety git helpers collected stdout with `+= chunk`,
 * decoding every Buffer on its own. A multibyte UTF-8 character split across a
 * pipe-chunk boundary became U+FFFD U+FFFD: a changed path matched no file (it
 * silently left the review) or no author entry, and a diff handed to the
 * reviewer held text the file never had. Real pipes split wherever they like,
 * so the fake child here splits deterministically inside `ş`.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: mockSpawn,
}));
// The git isolation lookup runs its own `git config`; these tests are about
// decoding the spawned command's output, so the lookup answers "nothing to blank".
vi.mock('@wrongstack/primitives', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@wrongstack/primitives')>()),
  gitIsolationEnv: async () => ({}),
}));
vi.mock('../../src/vcs/vcs-adapter.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/vcs/vcs-adapter.js')>()),
  gitFilterIsolationEnv: async () => ({}),
}));

import { EventBus } from '@wrongstack/contracts/kernel/events';
import { assessCommitSafety } from '../../src/coordination/commit-safety.js';
import { getChangedFiles } from '../../src/plugins/auto-review-git.js';
import { createChimeraPlugin } from '../../src/plugins/chimera-plugin.js';
import { buildReviewContext } from '../../src/plugins/review-context-builder.js';

/** A child whose stdout carries `text` cut between the two bytes of its first `ş`. */
function splitChild(text: string) {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough };
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  setImmediate(() => {
    child.stdout.on('end', () => child.emit('close', 0));
    const bytes = Buffer.from(text);
    const cut = bytes.indexOf(0xc5);
    if (cut === -1) child.stdout.write(bytes);
    else {
      child.stdout.write(bytes.subarray(0, cut + 1));
      child.stdout.write(bytes.subarray(cut + 1));
    }
    child.stdout.end();
  });
  return child;
}

let outputs: Record<string, string>;
beforeEach(() => {
  outputs = {};
  mockSpawn.mockReset();
  mockSpawn.mockImplementation((_cmd: string, args: string[]) =>
    splitChild(outputs[args.slice(0, 2).join(' ')] ?? ''),
  );
});

describe('git helpers decode stdout across chunk boundaries', () => {
  it('auto-review keeps a split multibyte path', async () => {
    outputs['status --porcelain'] = ' M şema.ts\0';
    expect(await getChangedFiles('/repo')).toEqual([{ path: 'şema.ts', status: 'modified' }]);
  });

  it('commit safety keeps a split multibyte path', async () => {
    outputs['status --porcelain'] = '?? şema.ts\0';
    outputs['rev-parse --show-toplevel'] = '/repo\n';
    const report = await assessCommitSafety({
      cwd: '/repo',
      projectRoot: '/repo',
      storageDir: '/nonexistent-store',
    });
    expect(report.unverifiedFiles).toEqual(['şema.ts']);
  });

  it('chimera reviews a file whose split multibyte path arrives in two chunks', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'chimera-utf8-'));
    try {
      await fs.writeFile(path.join(tmp, 'şema.ts'), 'export {};\n');
      outputs['rev-parse --git-dir'] = '.git\n';
      outputs['status --porcelain'] = '?? şema.ts\0';
      const bus = new EventBus();
      const handlers: Record<string, () => Promise<void>> = {};
      const emitCustom = vi.fn((event: string, payload: unknown) => bus.emitCustom(event, payload));
      createChimeraPlugin().setup!({
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
      } as never);
      await handlers['session.ended']!();

      const payload = emitCustom.mock.calls.find(([e]) => e === 'chimera.review_needed')?.[1] as
        | { files: Array<{ path: string }> }
        | undefined;
      expect(payload?.files.map((f) => f.path)).toEqual(['şema.ts']);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  it('the review context keeps a split multibyte diff', async () => {
    const diff = 'diff --git a/x.md b/x.md\n-eski şey\n+yeni şey\n';
    outputs['diff --no-ext-diff'] = diff;
    const bundle = await buildReviewContext({
      cwd: '/repo',
      config: {} as never,
      files: [{ path: 'x.md', status: 'modified', content: 'yeni şey\n' }],
    });
    expect(bundle.files[0]?.diff).toBe(diff);
  });
});
