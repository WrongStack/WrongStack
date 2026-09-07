import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Which TypeScript language server a workspace can actually use.
 *
 * TypeScript 7 ships a native binary with no `tsserver.js`, so
 * `typescript-language-server` — which drives tsserver — refuses to start:
 * "provides no tsserver.js. No other valid TypeScript installation was found."
 * That same binary speaks LSP directly (`tsc --lsp --stdio`), so the choice is
 * per workspace, not per machine.
 */
export type TypeScriptFlavor = 'native' | 'tsserver' | 'unknown';

/**
 * Major version of the nearest workspace TypeScript, walking up from `cwd`.
 * `undefined` when the project has no TypeScript of its own.
 */
export async function workspaceTypeScriptMajor(cwd: string): Promise<number | undefined> {
  let dir = path.resolve(cwd);
  for (;;) {
    const manifest = path.join(dir, 'node_modules', 'typescript', 'package.json');
    try {
      const raw = await fs.readFile(manifest, 'utf8');
      const version = (JSON.parse(raw) as { version?: unknown }).version;
      if (typeof version === 'string') {
        const major = Number.parseInt(version, 10);
        if (Number.isInteger(major)) return major;
      }
      return undefined;
    } catch {
      // Not here — keep walking.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function detectTypeScriptFlavor(cwd: string): Promise<TypeScriptFlavor> {
  const major = await workspaceTypeScriptMajor(cwd);
  if (major === undefined) return 'unknown';
  return major >= 7 ? 'native' : 'tsserver';
}

/**
 * Both TypeScript presets claim the same language ids, and the registry gives
 * a language to whichever server claims it first — so exactly one of them may
 * survive discovery. An unknown flavor keeps `typescript`
 * (typescript-language-server): a bare `tsc` on PATH is usually an unrelated
 * global install, and guessing wrong there means spawning a compiler that
 * never speaks LSP.
 */
export function typeScriptPresetFor(flavor: TypeScriptFlavor): 'typescript' | 'typescript-native' {
  return flavor === 'native' ? 'typescript-native' : 'typescript';
}
