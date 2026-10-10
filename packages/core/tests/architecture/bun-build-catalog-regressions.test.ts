import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { toolCatalog } from '../../../../website/src/data/runtime-catalog.js';

const root = resolve(import.meta.dirname, '../../../..');
const fixtures: string[] = [];
function fixture() {
  const base = join(root, '.temp_files');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'bun-build-catalog-'));
  fixtures.push(dir);
  return dir;
}
function put(dir: string, file: string, content: string) {
  const target = join(dir, file);
  mkdirSync(resolve(target, '..'), { recursive: true });
  writeFileSync(target, content);
}
function run(dir: string, script: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, WRONGSTACK_WORKSPACE_BUILD: '' },
    windowsHide: true,
  });
}
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('Bun workspace build discovery', () => {
  function workspace() {
    const dir = fixture();
    put(
      dir,
      'package.json',
      JSON.stringify({ type: 'module', workspaces: ['packages/*', 'website'] }),
    );
    put(dir, 'scripts/build.mjs', readFileSync(join(root, 'scripts/build.mjs'), 'utf8'));
    put(
      dir,
      'scripts/lib/publishable-packages.mjs',
      readFileSync(join(root, 'scripts/lib/publishable-packages.mjs'), 'utf8'),
    );
    for (const [location, name, marker] of [
      ['packages/leaf', '@wrongstack/leaf', 'leaf'],
      ['website', '@wrongstack/site', 'site'],
    ]) {
      put(
        dir,
        `${location}/package.json`,
        JSON.stringify({
          name,
          scripts: { build: `bun -e "console.log('BUILT:${marker}')"` },
          ...(marker === 'site' ? { dependencies: { '@wrongstack/leaf': 'workspace:*' } } : {}),
        }),
      );
    }
    return dir;
  }
  it('builds literal directory workspaces after their dependencies', () => {
    const result = run(workspace(), 'scripts/build.mjs');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/^BUILT:.+$/gm)).toEqual(['BUILT:leaf', 'BUILT:site']);
  });
  it('accepts a directory workspace as a target and builds its dependency closure', () => {
    const result = run(workspace(), 'scripts/build.mjs', '--target', 'website');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.match(/^BUILT:.+$/gm)).toEqual(['BUILT:leaf', 'BUILT:site']);
  });
});

describe('website tool catalog uniqueness', () => {
  function catalogFixture(duplicate: boolean) {
    const dir = fixture();
    put(dir, 'package.json', '{"type":"module"}');
    put(
      dir,
      'scripts/generate-website-tool-catalog.ts',
      readFileSync(join(root, 'scripts/generate-website-tool-catalog.ts'), 'utf8'),
    );
    const entry = {
      name: 'alpha',
      summary: 'Alpha tool',
      permission: 'auto',
      mutating: false,
      category: 'Discovery & index',
    };
    put(
      dir,
      'packages/tools/dist/builtin.js',
      `export const builtinTools = ${JSON.stringify([{ name: 'alpha', description: entry.summary, permission: entry.permission, mutating: false, inputSchema: { properties: {} } }])};`,
    );
    put(
      dir,
      'packages/tools/dist/tool-tier.js',
      'export const BUILTIN_TIER_COUNTS = { short: 1 };',
    );
    put(
      dir,
      'website/src/data/runtime-catalog.ts',
      `export const toolCatalog = ${JSON.stringify(duplicate ? [entry, entry, entry] : [entry])} as const;\n// generated:tool-tier-counts\nexport const TOOL_TIER_COUNTS = { short: 1 } as const;`,
    );
    put(
      dir,
      'website/src/data/tool-details.ts',
      'export const toolDetails = { alpha: { longDescription: "Alpha tool", params: [] } };',
    );
    return dir;
  }
  it('keeps the real website catalog unique', () => {
    expect(new Set(toolCatalog.map((tool) => tool.name)).size).toBe(toolCatalog.length);
  });
  it('accepts a unique catalog matching the runtime', () => {
    const result = run(catalogFixture(false), 'scripts/generate-website-tool-catalog.ts');
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('current (1 tools)');
  });
  it.each([{ args: [] }, { args: ['--write'] }])(
    'rejects repeated names without writing projections ($args)',
    ({ args }) => {
      const dir = catalogFixture(true);
      const file = join(dir, 'website/src/data/runtime-catalog.ts');
      const before = readFileSync(file, 'utf8');
      const result = run(dir, 'scripts/generate-website-tool-catalog.ts', ...args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Duplicate website tool names: alpha');
      expect(readFileSync(file, 'utf8')).toBe(before);
    },
  );
});
