/**
 * The worker-model menu in the leader's Delegation guidance.
 *
 * `delegate` / `spawn_subagent` take `provider`, `model` and `tier`, but the
 * leader was never told what any of them resolve to: the provider field named
 * "anthropic"/"openai" as examples (often not configured at all), and a tier
 * was an abstract cost word. In practice the leader never set a provider or a
 * model. This renders what the config actually offers — the tier ladder with
 * the model each level lands on, the role routes that already pick a model,
 * and the configured providers — so a model choice is an informed one.
 *
 * Host-side only: the text reaches the system prompt through
 * `Tool.promptVars`, never the wire schema.
 */

import type { Config } from '@wrongstack/contracts/types/config';
import { resolveModelTargetFromEntry } from './model-matrix.js';
import { listTierIds, resolveTier, tierLevel, tierModelTarget } from './model-tier.js';

/** Roles named per routing-table line before the rest are counted. */
const MAX_ROUTED_ROLES_PER_LINE = 8;

function targetLabel(target: { provider?: string | undefined; model?: string | undefined }) {
  if (!target.model) return undefined;
  return target.provider ? `${target.provider}/${target.model}` : target.model;
}

function tierLines(config: Config): string[] {
  const lines: string[] = [];
  for (const id of listTierIds(config)) {
    const level = tierLevel(config, id);
    const label = targetLabel(tierModelTarget(config, level) ?? {});
    if (!label) continue;
    const description = level?.description?.trim();
    lines.push(`  - \`${id}\` → ${label}${description ? ` — ${description}` : ''}`);
  }
  return lines;
}

/** Matrix routes grouped by the model they land on, e.g. "reviewer, critic → x/y". */
function routeLines(config: Config): string[] {
  const groups = new Map<string, string[]>();
  for (const [key, entry] of Object.entries(config.modelMatrix ?? {})) {
    const target = resolveModelTargetFromEntry(config, entry);
    const label = target ? targetLabel(target) : undefined;
    if (!label) continue;
    const keys = groups.get(label) ?? [];
    keys.push(key === '*' ? 'every other role' : key);
    groups.set(label, keys);
  }
  return [...groups].map(([label, keys]) => {
    const shown = keys.slice(0, MAX_ROUTED_ROLES_PER_LINE).join(', ');
    const more =
      keys.length > MAX_ROUTED_ROLES_PER_LINE ? ` +${keys.length - MAX_ROUTED_ROLES_PER_LINE}` : '';
    return `  - ${shown}${more} → ${label}`;
  });
}

/**
 * Render the menu, or `''` when the config offers nothing beyond the leader's
 * own model (no tiers, no routes, no providers) — the guidance then reads
 * exactly as it did before the menu existed.
 */
export function renderLeaderModelMenu(
  config: Config | undefined,
  session?: { provider?: string | undefined; model?: string | undefined } | undefined,
): string {
  if (!config) return '';
  const tiers = tierLines(config);
  const routes = routeLines(config);
  const providers = Object.keys(config.providers ?? {});
  if (tiers.length === 0 && routes.length === 0 && providers.length === 0) return '';

  const lines = ['Worker models available here:'];
  const own = session ? targetLabel(session) : undefined;
  // With tiers on, an unrouted worker does NOT inherit the leader's model: the
  // tier ladder falls through to its default level and fills the model there.
  const fallback = resolveTier(config, {});
  const fallbackLabel = fallback ? targetLabel(fallback) : undefined;
  if (fallback && fallbackLabel) {
    lines.push(
      `- Default: a worker with no route below and no \`tier\` runs on tier \`${fallback.tier}\` → ${fallbackLabel}${own ? ` (you run on ${own})` : ''}.`,
    );
  } else if (own) {
    lines.push(`- Default: a worker with no route below runs on your own model, ${own}.`);
  }
  if (routes.length > 0) {
    // A chosen tier outranks a route (see `resolveDirectorSpawnModel`), so the
    // leader is told both ways off the route, not just the provider+model one.
    lines.push(
      '- Routed by the user — these roles get this model unless you pass a `tier` or an explicit `provider` + `model`:',
      ...routes,
    );
  }
  if (tiers.length > 0) {
    lines.push('- `tier` levels — the simplest way to go cheaper or stronger:', ...tiers);
  }
  if (providers.length > 0) {
    lines.push(
      `- Configured providers: ${providers.join(', ')}. For an explicit pick pass \`provider\` AND \`model\` together — a provider alone is not enough: the model is then filled from your \`tier\`, the routing table, the default tier or your own model.`,
    );
  }
  return lines.join('\n');
}
