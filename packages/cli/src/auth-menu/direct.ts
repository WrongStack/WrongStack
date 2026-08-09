import type { WireFamily } from '@wrongstack/core/types';
import {
  mutateConfigProviders,
  normalizeKeys,
  nowIso,
  writeKeysBack,
} from '../provider-config-utils.js';
import { loadProviders } from './helpers.js';
import { readKeyInput } from './shared.js';
import type { AuthMenuDeps } from './types.js';

/**
 * One-shot add: used by `wstack auth <provider>` to skip the menu and
 * append a single key. Honors --label / --family / --base-url / --env
 * flags. If the label collides, we suffix with a counter.
 */
export async function runAuthDirect(
  deps: AuthMenuDeps,
  opts: {
    providerId: string;
    label?: string | undefined;
    family?: WireFamily | undefined;
    baseUrl?: string | undefined;
    envVars?: string[] | undefined;
  },
): Promise<number> {
  const { providerId } = opts;
  const providers = await loadProviders(deps);
  const existing = providers[providerId];

  if (!existing && !opts.family) {
    // Try the catalog before giving up
    let knownFamily: WireFamily | undefined;
    let knownBase: string | undefined;
    let knownEnv: string[] | undefined;
    try {
      const k = await deps.modelsRegistry.getProvider(providerId);
      if (k) {
        knownFamily = k.family as WireFamily;
        knownBase = k.apiBase;
        knownEnv = k.envVars;
      }
    } catch {
      // catalog unavailable
    }
    if (!knownFamily || knownFamily === 'unsupported') {
      deps.renderer.writeError(
        `Provider "${providerId}" not in catalog. Pass --family <anthropic|openai|openai-compatible|google>.`,
      );
      return 1;
    }
    opts.family = knownFamily;
    opts.baseUrl ??= knownBase;
    opts.envVars ??= knownEnv;
  }

  const usedLabels = new Set(existing ? normalizeKeys(existing).map((k) => k.label) : []);
  let label = opts.label ?? 'default';
  if (usedLabels.has(label)) {
    let n = 2;
    while (usedLabels.has(`${label}-${n}`)) n++;
    label = `${label}-${n}`;
    deps.renderer.writeInfo(`Label collided; saving as "${label}".`);
  }

  const apiKey = await readKeyInput(deps, `API key for ${providerId}/${label}`);
  if (!apiKey) return 1;

  await mutateConfigProviders(
    deps.profileConfigPath,
    deps.vault,
    (all) => {
      const p = all[providerId] ?? { type: providerId };
      if (!p.type) p.type = providerId;
      if (!p.family && opts.family) p.family = opts.family;
      if (!p.baseUrl && opts.baseUrl) p.baseUrl = opts.baseUrl;
      if (!p.envVars && opts.envVars) p.envVars = opts.envVars;
      const list = normalizeKeys(p);
      list.push({ label, apiKey, createdAt: nowIso() });
      writeKeysBack(p, list);
      if (!p.activeKey) p.activeKey = label;
      all[providerId] = p;
    },
    deps.profileConfigPath,
  );

  deps.renderer.writeInfo(`Stored encrypted key for ${providerId} (label "${label}").`);
  deps.renderer.writeInfo(`Use: wstack --provider ${providerId} "<task>"`);
  return 0;
}
