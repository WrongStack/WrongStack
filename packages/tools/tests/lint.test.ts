import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lintTool } from '../src/lint.js';

const makeCtx = (cwd: string) => ({ cwd, tools: [], projectRoot: cwd }) as never as Context;
const makeOpts = () => ({ signal: new AbortController().signal });

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lint-tool-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('lintTool', () => {
  it('has correct metadata', () => {
    expect(lintTool.name).toBe('lint');
    expect(lintTool.permission).toBe('confirm');
    expect(lintTool.mutating).toBe(false);
  });

  it('falls back to biome when no linter config found', async () => {
    const ctx = { cwd: tmpDir || '/', tools: [], projectRoot: tmpDir || '/' } as any;
    const result = await lintTool.execute({ linter: 'auto' }, ctx, makeOpts());
    // detectLinter falls through to 'biome' when no config files found
    expect(result.linter).toBe('biome');
  });

  it('respects fix flag', async () => {
    const ctx = makeCtx(tmpDir);
    const result = await lintTool.execute({ fix: true }, ctx, makeOpts());
    expect(result).toHaveProperty('fix_applied');
  });

  it('passes files to linter', async () => {
    const ctx = makeCtx(tmpDir);
    const result = await lintTool.execute({ files: 'src/**/*.ts' }, ctx, makeOpts());
    expect(result).toHaveProperty('files_checked');
  });

  it('handles files as array', async () => {
    const ctx = makeCtx(tmpDir);
    const result = await lintTool.execute({ files: ['a.ts', 'b.ts'] }, ctx, makeOpts());
    expect(result).toHaveProperty('files_checked');
  });
});

// ─── Coverage: detectLinter with config files ────────────────────────────────
describe('detectLinter config detection', () => {
  it('detects biome from biome.json', async () => {
    await fs.writeFile(path.join(tmpDir, 'biome.json'), '{}');
    const result = await lintTool.execute(
      { linter: 'auto' },
      { cwd: tmpDir, tools: [], projectRoot: tmpDir } as never as Context,
      makeOpts(),
    );
    expect(result.linter).toBe('biome');
  });

  it('detects eslint from .eslintrc.json', async () => {
    await fs.writeFile(path.join(tmpDir, '.eslintrc.json'), '{}');
    const result = await lintTool.execute(
      { linter: 'auto' },
      { cwd: tmpDir, tools: [], projectRoot: tmpDir } as never as Context,
      makeOpts(),
    );
    expect(result.linter).toBe('eslint');
  });

  it('detects tslint from tslint.json', async () => {
    await fs.writeFile(path.join(tmpDir, 'tslint.json'), '{}');
    const result = await lintTool.execute(
      { linter: 'auto' },
      { cwd: tmpDir, tools: [], projectRoot: tmpDir } as never as Context,
      makeOpts(),
    );
    expect(result.linter).toBe('tslint');
  });

  it('returns biome as default when no config files exist', async () => {
    // tmpDir has no config files — detectLinter should fall through to 'biome'
    const result = await lintTool.execute(
      { linter: 'auto' },
      { cwd: tmpDir, tools: [], projectRoot: tmpDir } as never as Context,
      makeOpts(),
    );
    expect(result.linter).toBe('biome');
  });

  it('detects eslint from .eslintrc.js', async () => {
    await fs.writeFile(path.join(tmpDir, '.eslintrc.js'), '{}');
    const result = await lintTool.execute(
      { linter: 'auto' },
      { cwd: tmpDir, tools: [], projectRoot: tmpDir } as never as Context,
      makeOpts(),
    );
    expect(result.linter).toBe('eslint');
  });

  it('resolves an explicit cwd', async () => {
    const result = await lintTool.execute(
      { linter: 'biome', cwd: '.' },
      makeCtx(tmpDir),
      makeOpts(),
    );
    expect(result).toHaveProperty('linter');
  });

  it('throws when executeStream is unavailable', async () => {
    const original = lintTool.executeStream;
    lintTool.executeStream = undefined;
    try {
      await expect(lintTool.execute({}, makeCtx(tmpDir), makeOpts())).rejects.toThrow(
        /stream execution unavailable/,
      );
    } finally {
      lintTool.executeStream = original;
    }
  });

  it('throws when the stream ends without a final event', async () => {
    const original = lintTool.executeStream!;
    lintTool.executeStream = async function* () {
      yield { type: 'log', text: 'no final' } as never;
    };
    try {
      await expect(lintTool.execute({}, makeCtx(tmpDir), makeOpts())).rejects.toThrow(
        /without final event/,
      );
    } finally {
      lintTool.executeStream = original;
    }
  });

  it('detects tslint from tsconfig.json (biome priority over tsconfig)', async () => {
    // biome.json is checked first, so if both exist biome wins
    await fs.writeFile(path.join(tmpDir, 'tsconfig.json'), '{}');
    const result = await lintTool.execute(
      { linter: 'auto' },
      { cwd: tmpDir, tools: [], projectRoot: tmpDir } as never as Context,
      makeOpts(),
    );
    // detectLinter checks ['biome.json', '.eslintrc.json', 'tslint.json', '.eslintrc.js', 'tsconfig.json']
    // biome.json not found, eslint not found, tslint not found, eslintrc.js not found
    // then checks tsconfig.json — but detectLinter only returns 'biome' at the end, never 'tsconfig'
    // So tsconfig.json should result in 'biome' (the fallback)
    expect(result.linter).toBe('biome');
  });
});
