import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { SlashCommandRegistry } from '@wrongstack/core/registry';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SlashCommandContext } from '../src/slash-commands/index.js';
import { buildBuiltinSlashCommands } from '../src/slash-commands/index.js';

class FakeRenderer {
  buf = '';
  write(s: string) {
    this.buf += s;
  }
  writeInfo(s: string) {
    this.buf += `INFO: ${s}\n`;
  }
  writeWarning(s: string) {
    this.buf += `WARN: ${s}\n`;
  }
  writeError(s: string) {
    this.buf += `ERR: ${s}\n`;
  }
  writeToolCall() {}
  writeToolResult() {}
}

function makeRegistry(renderer: FakeRenderer) {
  const reg = new SlashCommandRegistry();
  const cmds = buildBuiltinSlashCommands({
    registry: reg,
    toolRegistry: { list: () => [] },
    renderer,
    tokenCounter: { total: () => ({ input: 0, output: 0 }) },
  } as never as SlashCommandContext);
  for (const c of cmds) reg.register(c);
  return reg;
}

describe('/init slash command', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-init-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  function mkCtx(): Context {
    return { projectRoot: tmp } as never as Context;
  }

  it('writes .wrongstack/AGENTS.md when missing', async () => {
    const r = new FakeRenderer();
    const reg = makeRegistry(r);
    await reg.dispatch('/init', mkCtx());
    const written = await fs.readFile(path.join(tmp, '.wrongstack', 'AGENTS.md'), 'utf8');
    expect(written).toContain('# AGENTS.md');
    expect(written).toContain('persistent project context');
    expect(written).toContain('## Project brief');
    expect(written).toContain('## How to work safely');
    expect(written).toContain('## Verification checklist');
    expect(written).toContain('Build');
    expect(written).toContain('Test');
    expect(r.buf).toContain('INFO: Wrote');
  });

  it('overwrites existing AGENTS.md with fresh template', async () => {
    await fs.mkdir(path.join(tmp, '.wrongstack'), { recursive: true });
    await fs.writeFile(path.join(tmp, '.wrongstack', 'AGENTS.md'), 'EXISTING');
    const r = new FakeRenderer();
    const reg = makeRegistry(r);
    await reg.dispatch('/init', mkCtx());
    const written = await fs.readFile(path.join(tmp, '.wrongstack', 'AGENTS.md'), 'utf8');
    expect(written).toContain('# AGENTS.md');
    expect(written).not.toBe('EXISTING');
  });

  it('detects package.json scripts and pre-fills build/test/lint/run', async () => {
    await fs.writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        scripts: { build: 'tsc', test: 'vitest', lint: 'eslint .', dev: 'vite' },
        packageManager: 'pnpm@9.0.0',
      }),
    );
    const r = new FakeRenderer();
    const reg = makeRegistry(r);
    await reg.dispatch('/init', mkCtx());
    const written = await fs.readFile(path.join(tmp, '.wrongstack', 'AGENTS.md'), 'utf8');
    expect(written).toContain('`pnpm run build`');
    expect(written).toContain('`pnpm test`');
    expect(written).toContain('`pnpm run lint`');
    expect(written).toContain('`pnpm run dev`');
    expect(r.buf).toContain('Pre-filled');
    expect(r.buf).toContain('package.json scripts');
  });

  it('uses pnpm when package.json has no packageManager but pnpm-lock.yaml exists', async () => {
    await fs.writeFile(
      path.join(tmp, 'package.json'),
      JSON.stringify({
        scripts: { build: 'tsc', test: 'vitest' },
      }),
    );
    await fs.writeFile(path.join(tmp, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    const r = new FakeRenderer();
    const reg = makeRegistry(r);
    await reg.dispatch('/init', mkCtx());
    const written = await fs.readFile(path.join(tmp, '.wrongstack', 'AGENTS.md'), 'utf8');
    expect(written).toContain('`pnpm run build`');
    expect(written).toContain('`pnpm test`');
  });

  it('detects Go module commands', async () => {
    await fs.writeFile(path.join(tmp, 'go.mod'), 'module example\ngo 1.21\n');
    const r = new FakeRenderer();
    const reg = makeRegistry(r);
    await reg.dispatch('/init', mkCtx());
    const written = await fs.readFile(path.join(tmp, '.wrongstack', 'AGENTS.md'), 'utf8');
    expect(written).toContain('`go build ./...`');
    expect(written).toContain('`go test ./...`');
    expect(written).toContain('`go run .`');
  });

  it('detects Makefile targets without inventing missing ones', async () => {
    await fs.writeFile(
      path.join(tmp, 'Makefile'),
      ['build:', '\techo build', 'lint:', '\techo lint', 'run:', '\techo run', ''].join('\n'),
    );
    const r = new FakeRenderer();
    const reg = makeRegistry(r);
    await reg.dispatch('/init', mkCtx());
    const written = await fs.readFile(path.join(tmp, '.wrongstack', 'AGENTS.md'), 'utf8');
    expect(written).toContain('`make build`');
    expect(written).toContain('`make lint`');
    expect(written).toContain('`make run`');
  });
});
