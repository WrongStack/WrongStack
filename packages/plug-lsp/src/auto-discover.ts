import { PRESETS } from './presets.js';
import type { ServerConfig } from './types.js';
import { resolveServerCommand } from './utils/command-resolver.js';

export async function autoDiscoverServers(
  userServers: Record<string, ServerConfig>,
  cwd = process.cwd(),
): Promise<Record<string, ServerConfig>> {
  const out = { ...userServers };
  const pending = Object.entries(PRESETS).filter(([name]) => !out[name]);
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
