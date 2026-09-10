import { PRESETS } from './presets.js';
import type { ServerConfig } from './types.js';
import { detectTypeScriptFlavor, typeScriptPresetFor } from './typescript-flavor.js';
import { findLocalBinary, resolveServerCommand } from './utils/command-resolver.js';

const TYPESCRIPT_PRESETS = ['typescript', 'typescript-native'] as const;

/**
 * Auto-discovery resolves preset servers **from PATH only** (WS-SEC-01).
 *
 * It runs unattended on every session start, and the server it picks is spawned
 * without a confirmation prompt (`index.ts` starts it from `tool.executed`
 * after any edit/write when `diagnosticsAfterEdit: 'background'`). Consulting
 * `<repo>/node_modules/.bin` here therefore let a cloned repository choose an
 * executable and get it run: commit `node_modules/.bin/gopls`, wait for the
 * agent to edit one file, done. PATH is the user's own environment; the opened
 * repository is not.
 *
 * A project-local server is still reachable — `/lsp setup`, `/lsp install` and
 * `/lsp` all pass `allowProjectLocal: true`, because there the user named the
 * command for this project and is present to see it. `notifyProjectLocal`
 * exists so that path stays discoverable rather than silently missing: when a
 * preset binary is present in `node_modules/.bin` but not on PATH, we say so
 * instead of leaving the user with a language server that just does not start.
 */
export async function autoDiscoverServers(
  userServers: Record<string, ServerConfig>,
  cwd = process.cwd(),
  notifyProjectLocal?: ((message: string) => void) | undefined,
): Promise<Record<string, ServerConfig>> {
  const out = { ...userServers };
  // Only one TypeScript preset may be discovered: both claim the same
  // languages, and a workspace on TypeScript 7 cannot run tsserver at all.
  const wanted = typeScriptPresetFor(await detectTypeScriptFlavor(cwd));
  const pending = Object.entries(PRESETS).filter(
    ([name]) =>
      !out[name] &&
      !(isTypeScriptPreset(name) && name !== wanted) &&
      // A user who configured either TypeScript server by hand keeps it.
      !(isTypeScriptPreset(name) && TYPESCRIPT_PRESETS.some((p) => userServers[p])),
  );
  const resolved = await Promise.all(
    pending.map(
      async ([name, cfg]) => [name, cfg, await resolveServerCommand(cfg.command, cwd)] as const,
    ),
  );
  for (const [name, cfg, command] of resolved) {
    if (command) out[name] = { ...cfg, command };
  }
  if (notifyProjectLocal) {
    await notifyUnadoptedProjectLocal(resolved, cwd, notifyProjectLocal);
  }
  return out;
}

/**
 * Report presets that exist in `node_modules/.bin` but were not adopted
 * because they are not on PATH. This is the legitimate half of the WS-SEC-01
 * surface — a repo that lists `typescript-language-server` as a devDependency —
 * and without a notice the user would see no LSP and no reason why.
 *
 * Deliberately reports the *name*, not the resolved path, and never adopts.
 */
async function notifyUnadoptedProjectLocal(
  resolved: ReadonlyArray<readonly [string, ServerConfig, string | null]>,
  cwd: string,
  notify: (message: string) => void,
): Promise<void> {
  const candidates = await Promise.all(
    resolved
      .filter(([, , command]) => command === null)
      .map(async ([name, cfg]) => ((await findLocalBinary(cwd, cfg.command)) ? name : null)),
  );
  const names = candidates.filter((name): name is string => name !== null);
  if (names.length === 0) return;
  notify(
    `plug-lsp: ${names.join(', ')} found in node_modules/.bin but not on PATH. ` +
      'Project-local binaries are not auto-started, because a repository can supply one. ' +
      `Run \`/lsp setup ${names[0]}\` to adopt it for this project.`,
  );
}

function isTypeScriptPreset(name: string): boolean {
  return (TYPESCRIPT_PRESETS as readonly string[]).includes(name);
}
