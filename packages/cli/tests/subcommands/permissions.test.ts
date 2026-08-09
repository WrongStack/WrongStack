import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ToolRegistry } from '@wrongstack/core/registry';
import { normalizeTokenSavingTier } from '@wrongstack/core/types';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { registerBuiltinToolTier } from '@wrongstack/tools/tool-tier';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type SubcommandDeps, subcommands } from '../../src/subcommands/index.js';

// Regression coverage for the `wstack permissions explain` handler (#281):
//   1. it must be reachable — registered in the subcommands dispatch map;
//   2. `--input` / `--json` must be read from `deps.flags`, because the
//      top-level arg parser strips flags out of the positional args.

function mkRig() {
  const out = { buf: '' };
  const err = { buf: '' };
  const renderer = {
    write: (msg: string) => {
      out.buf += msg;
    },
    writeError: (msg: string) => {
      err.buf += msg;
    },
    writeInfo: (msg: string) => {
      out.buf += msg + '\n';
    },
  };
  return { out, err, renderer };
}

function mkDeps(rig: ReturnType<typeof mkRig>, over: Partial<SubcommandDeps> = {}): SubcommandDeps {
  const registry = new ToolRegistry();
  registerBuiltinToolTier({ registry, tier: normalizeTokenSavingTier(undefined) });
  return {
    config: { providers: {}, log: { level: 'error' } } as never,
    renderer: rig.renderer as never,
    reader: {
      readLine: vi.fn(async () => ''),
      readKey: vi.fn(async () => ''),
      close: vi.fn(async () => undefined),
    } as never,
    modelsRegistry: {} as never,
    toolRegistry: registry,
    paths: resolveWstackPaths({ projectRoot: tmp, globalRoot: tmp, userHome: tmp }),
    cwd: tmp,
    projectRoot: tmp,
    userHome: tmp,
    ...over,
  } as never as SubcommandDeps;
}

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-perm-'));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('permissions subcommand (#281 wiring)', () => {
  it('is registered in the dispatch map (reachable)', () => {
    expect(subcommands['permissions']).toBeDefined();
  });

  it('prints usage and returns 0 with no args', async () => {
    const rig = mkRig();
    const code = await subcommands['permissions']!([], mkDeps(rig));
    expect(code).toBe(0);
    expect(rig.out.buf).toMatch(/permissions explain/);
  });

  it('returns 1 and errors on an unknown subcommand', async () => {
    const rig = mkRig();
    const code = await subcommands['permissions']!(['frobnicate'], mkDeps(rig));
    expect(code).toBe(1);
    expect(rig.err.buf).toMatch(/Unknown permissions subcommand/);
  });

  it('reads --json from deps.flags and emits a JSON trace for a real tool', async () => {
    const rig = mkRig();
    const deps = mkDeps(rig);
    const toolName = deps.toolRegistry!.list()[0]!.name;
    const code = await subcommands['permissions']!(
      ['explain', toolName],
      // Flags are stripped from args by the parser; the handler must read here.
      { ...deps, flags: { json: true } },
    );
    expect(code).toBe(0);
    const parsed = JSON.parse(rig.out.buf);
    expect(parsed.toolName).toBe(toolName);
  });

  it('reads --input from deps.flags (invalid JSON is rejected)', async () => {
    const rig = mkRig();
    const deps = mkDeps(rig);
    const toolName = deps.toolRegistry!.list()[0]!.name;
    const code = await subcommands['permissions']!(['explain', toolName], {
      ...deps,
      flags: { input: '{not-json' },
    });
    expect(code).toBe(1);
    expect(rig.err.buf).toMatch(/Invalid --input JSON/);
  });
});
