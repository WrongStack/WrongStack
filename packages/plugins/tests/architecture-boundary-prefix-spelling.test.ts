import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { PluginAPI, Tool } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import architectureBoundaryChecker from '../src/architecture-boundary-checker/index.js';

let root: string;
let api: PluginAPI;
const tools = new Map<string, Tool>();

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wrongstack-arch-prefix-'));
  tools.clear();
  api = {
    config: { extensions: {} },
    log: { info() {}, warn() {}, error() {} },
    tools: { register: (tool: Tool) => tools.set(tool.name, tool) },
  } as unknown as PluginAPI;
  architectureBoundaryChecker.setup(api);
  for (const [path, source] of [
    ['src/ui/a.ts', "import { b } from '../db/b';\nexport const a = b;\n"],
    ['src/db/b.ts', 'export const b = 1;\n'],
  ] as const) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), source);
  }
});
afterEach(async () => {
  await architectureBoundaryChecker.teardown?.(api);
  await rm(root, { recursive: true, force: true });
});

async function violations(forbidden: Array<{ from: string; to: string }>) {
  const result = (await tools
    .get('architecture_boundaries')!
    .execute(
      { files: ['src/ui/a.ts', './src/db/b.ts'], forbidden },
      { projectRoot: root, cwd: root } as never,
      { signal: new AbortController().signal },
    )) as { violations: unknown[] };
  return result.violations;
}

const VIOLATION = [{ from: 'src/ui/a.ts', to: 'src/db/b.ts' }];

// F1118: file paths were normalized (`./` stripped, `\` -> `/`) but the
// forbidden prefixes were not, so a rule spelled `./src/ui` or `src\ui`
// never matched and the boundary check reported no violations.
describe('architecture-boundary-checker prefix spellings', () => {
  it('enforces a ./-prefixed forbidden rule', async () => {
    expect(await violations([{ from: './src/ui', to: './src/db/' }])).toEqual(VIOLATION);
  });

  it('enforces a backslash-separated forbidden rule', async () => {
    expect(await violations([{ from: 'src\\ui', to: 'src\\db\\' }])).toEqual(VIOLATION);
  });

  it('still keeps sibling directories outside a prefix', async () => {
    expect(await violations([{ from: './src/u', to: 'src/d' }])).toEqual([]);
    expect(await violations([{ from: 'src/ui', to: 'src/db' }])).toEqual(VIOLATION);
  });
});
