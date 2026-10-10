// @vitest-environment jsdom
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { renderHook } from '@testing-library/react';
import { SlashCommandRegistry } from '@wrongstack/core/registry';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useDesignKitSlashCommands } from '../src/hooks/use-design-kit-slash-commands.js';

/**
 * /design capture — the TUI surface for kit-less verify. It snapshots the
 * project's OWN token source (captureProjectTokens → saveCapturedTokens) so
 * /design verify has a basis while no kit is pinned, mirroring the tool's
 * capture action. Harness mirrors resume-slash-routing.test.ts: the hook is
 * rendered against the REAL registry and the command's run() is invoked.
 */

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tui-design-cap-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

function registeredDesignCommand(projectRoot: string) {
  const registry = new SlashCommandRegistry();
  const opts = {
    agent: { ctx: {} },
    slashRegistry: registry,
    dispatch: () => {},
    projectRoot,
  } as never;
  renderHook(() => useDesignKitSlashCommands(opts));
  const cmd = registry.get('design');
  expect(cmd, '/design should be registered').toBeDefined();
  return cmd!;
}

describe('/design capture', () => {
  it('captures a conventional CSS token source and reports the counts', async () => {
    await fs.mkdir(path.join(tmp, 'src'), { recursive: true });
    await fs.writeFile(
      path.join(tmp, 'src', 'index.css'),
      ':root {\n  --primary: 222 47% 11%;\n  --background: oklch(99% 0 0);\n}\n.dark {\n  --primary: 210 40% 96%;\n}\n',
    );
    const cmd = registeredDesignCommand(tmp);

    const res = await cmd.run('capture');
    expect(res?.message).toMatch(/Captured \d+ token value\(s\) \(\d+ light \/ \d+ dark\)/);
    expect(res?.message).toContain('src/index.css');
    expect(res?.message).toContain('captured-tokens.json');
    expect(res?.message).toContain('while no kit is pinned');

    const persisted = JSON.parse(
      await fs.readFile(path.join(tmp, '.design', 'captured-tokens.json'), 'utf8'),
    ) as {
      files: string[];
      tokens: { light: Record<string, string>; dark: Record<string, string> };
    };
    expect(persisted.files).toEqual(['src/index.css']);
    expect(persisted.tokens.light['primary']).toMatch(/^#/);
    expect(persisted.tokens.dark['primary']).not.toBe(persisted.tokens.light['primary']);
  });

  it('accepts explicit files at non-conventional paths', async () => {
    await fs.writeFile(path.join(tmp, 'tokens.css'), ':root {\n  --primary: #123456;\n}\n');
    const cmd = registeredDesignCommand(tmp);

    const res = await cmd.run('capture tokens.css');
    expect(res?.message).toContain('tokens.css');
    const persisted = JSON.parse(
      await fs.readFile(path.join(tmp, '.design', 'captured-tokens.json'), 'utf8'),
    ) as { files: string[] };
    expect(persisted.files).toEqual(['tokens.css']);
  });

  it('reports "no tokens found" with guidance when the project has no token source', async () => {
    const cmd = registeredDesignCommand(tmp);

    const res = await cmd.run('capture');
    expect(res?.message).toMatch(/found no tokens/i);
    expect(res?.message).toContain('Pass files explicitly');
  });
});
