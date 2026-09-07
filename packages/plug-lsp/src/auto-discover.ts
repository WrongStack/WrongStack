import { PRESETS } from './presets.js';
import type { ServerConfig } from './types.js';
import { detectTypeScriptFlavor, typeScriptPresetFor } from './typescript-flavor.js';
import { resolveServerCommand } from './utils/command-resolver.js';

const TYPESCRIPT_PRESETS = ['typescript', 'typescript-native'] as const;

export async function autoDiscoverServers(
  userServers: Record<string, ServerConfig>,
  cwd = process.cwd(),
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
  return out;
}

function isTypeScriptPreset(name: string): boolean {
  return (TYPESCRIPT_PRESETS as readonly string[]).includes(name);
}
