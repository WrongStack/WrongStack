import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Provider, SessionWriter } from '@wrongstack/core/types';
import { Context } from '@wrongstack/core/agent';
import { DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import { buildWorkingDirCommand } from '../../src/slash-commands/working-dir.js';
import type { SlashCommandContext } from '../../src/slash-commands/index.js';

// ── Helpers ────────────────────────────────────────────────────────────────

const fakeProvider = {} as Provider;
const fakeSession = {
  id: 't',
  pendingToolUses: [],
  append: async () => undefined,
  appendBatch: async () => undefined,
  flush: async () => undefined,
  close: async () => undefined,
} as never as SessionWriter;

function mkContext(overrides: {
  projectRoot: string;
  workingDir?: string | undefined;
}): Context {
  return new Context({
    systemPrompt: [{ type: 'text', text: 'hi' }],
    provider: fakeProvider,
    session: fakeSession,
    signal: new AbortController().signal,
    tokenCounter: new DefaultTokenCounter(),
    cwd: overrides.projectRoot,
    projectRoot: overrides.projectRoot,
    workingDir: overrides.workingDir ?? overrides.projectRoot,
    model: 'm',
  });
}

function mkDeps(): SlashCommandContext {
  return {
    registry: { register: () => undefined, dispatch: async () => undefined, list: () => [] },
    toolRegistry: { register: () => undefined, tools: [] },
    tokenCounter: new DefaultTokenCounter(),
    renderer: { write: () => {}, writeLine: () => {}, writeBlock: () => {}, writeToolCall: () => {}, writeToolResult: () => {}, writeDiff: () => {}, writeWarning: () => {}, writeError: () => {}, writeInfo: () => {}, clear: () => {} },
    events: { emit: () => {}, on: () => () => {}, off: () => {} },
    cwd: '/tmp',
    projectRoot: '/tmp',
  } as never as SlashCommandContext;
}

// ── Temp dir setup ─────────────────────────────────────────────────────────

let tmpRoot: string;
let subDir: string;

beforeEach(async () => {
  tmpRoot = path.join(os.tmpdir(), `wstack-wd-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  await fs.mkdir(tmpRoot, { recursive: true });
  subDir = path.join(tmpRoot, 'src');
  await fs.mkdir(subDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

// ── Tests ──────────────────────────────────────────────────────────────────

describe('/working_dir', () => {
  it('shows the current working directory when no args', async () => {
    const ctx = mkContext({ projectRoot: tmpRoot, workingDir: subDir });
    const cmd = buildWorkingDirCommand(mkDeps());
    const result = await cmd.run('', ctx);

    expect(result?.message).toContain(tmpRoot);
    expect(result?.message).toContain('src');
  });

  it('shows "." as relative path when at project root', async () => {
    const ctx = mkContext({ projectRoot: tmpRoot });
    const cmd = buildWorkingDirCommand(mkDeps());
    const result = await cmd.run('', ctx);

    expect(result?.message).toContain('(relative to root: .)');
  });

  it('navigates to a relative subdirectory', async () => {
    const ctx = mkContext({ projectRoot: tmpRoot });
    const cmd = buildWorkingDirCommand(mkDeps());
    const result = await cmd.run('src', ctx);

    expect(result?.message).toContain('✓');
    expect(ctx.workingDir).toBe(subDir);
  });

  it('navigates to an absolute path within the project', async () => {
    const ctx = mkContext({ projectRoot: tmpRoot });
    const cmd = buildWorkingDirCommand(mkDeps());
    const result = await cmd.run(subDir, ctx);

    expect(result?.message).toContain('✓');
    expect(ctx.workingDir).toBe(subDir);
  });

  it('shows dot-reset message when navigating to project root', async () => {
    const ctx = mkContext({ projectRoot: tmpRoot, workingDir: subDir });
    const cmd = buildWorkingDirCommand(mkDeps());
    const result = await cmd.run('.', ctx);

    expect(result?.message).toContain('✓');
    expect(ctx.workingDir).toBe(tmpRoot);
  });

  it('returns error for path outside project root', async () => {
    const ctx = mkContext({ projectRoot: tmpRoot });
    const cmd = buildWorkingDirCommand(mkDeps());
    const outside = path.join(os.tmpdir(), 'outside');
    const result = await cmd.run(outside, ctx);

    expect(result?.message).toContain('outside the project root');
  });

  it('returns error for relative path that escapes via ..', async () => {
    const ctx = mkContext({ projectRoot: tmpRoot });
    const cmd = buildWorkingDirCommand(mkDeps());
    const result = await cmd.run('../../etc', ctx);

    expect(result?.message).toContain('outside the project root');
  });

  it('returns error for non-existent directory', async () => {
    const ctx = mkContext({ projectRoot: tmpRoot });
    const cmd = buildWorkingDirCommand(mkDeps());
    const result = await cmd.run('nope', ctx);

    expect(result?.message).toContain('Directory does not exist');
  });

  it('returns error for a file (not a directory)', async () => {
    const ctx = mkContext({ projectRoot: tmpRoot });
    const cmd = buildWorkingDirCommand(mkDeps());
    // Create a file in the project root
    const filePath = path.join(tmpRoot, 'readme.txt');
    await fs.writeFile(filePath, 'hello');
    const result = await cmd.run('readme.txt', ctx);

    expect(result?.message).toContain('Not a directory');
  });

  it('returns no-active-context message when ctx is undefined', async () => {
    const cmd = buildWorkingDirCommand(mkDeps());
    const result = await cmd.run('', undefined);
    expect(result?.message).toContain('No active context');
  });

  it('aliases /wd and /cd have name and description', () => {
    const cmd = buildWorkingDirCommand(mkDeps());
    expect(cmd.name).toBe('working_dir');
    expect(cmd.aliases).toContain('wd');
    expect(cmd.aliases).toContain('cd');
  });

  it('updates workingDir after successful navigation', async () => {
    const ctx = mkContext({ projectRoot: tmpRoot });
    const cmd = buildWorkingDirCommand(mkDeps());
    const deeper = path.join(subDir, 'lib');
    await fs.mkdir(deeper, { recursive: true });

    await cmd.run('src', ctx);
    expect(ctx.workingDir).toBe(subDir);

    // Relative paths resolve from the PROJECT ROOT (documented convention,
    // pinned by the "resolves relative paths against projectRoot" test) —
    // so going deeper requires the full root-relative path.
    await cmd.run('src/lib', ctx);
    expect(ctx.workingDir).toBe(deeper);
  });

  it('does not change workingDir on failed navigation', async () => {
    const ctx = mkContext({ projectRoot: tmpRoot, workingDir: subDir });
    const cmd = buildWorkingDirCommand(mkDeps());

    const before = ctx.workingDir;
    await cmd.run('/etc', ctx);
    expect(ctx.workingDir).toBe(before); // unchanged
  });
});

describe('/wd alias', () => {
  it('shows current directory', async () => {
    const ctx = mkContext({ projectRoot: tmpRoot });
    const cmd = buildWorkingDirCommand(mkDeps());
    const result = await cmd.run('', ctx);
    expect(result?.message).toContain(tmpRoot);
  });
});

describe('/cd alias', () => {
  it('navigates to a subdirectory', async () => {
    const ctx = mkContext({ projectRoot: tmpRoot });
    const cmd = buildWorkingDirCommand(mkDeps());
    const result = await cmd.run('src', ctx);
    expect(result?.message).toContain('✓');
    expect(ctx.workingDir).toBe(subDir);
  });
});
