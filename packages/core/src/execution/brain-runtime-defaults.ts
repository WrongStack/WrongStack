import type { BrainConfig } from '@wrongstack/contracts/types/config';

export interface BrainDefaultsContext {
  /** The session's fallback chain (`config.fallbackModels`) — seeds the default pool. */
  fallbackModels?: readonly string[] | undefined;
}

// Default expansion is a boot-time view, not an explicit risk grant. Keep its
// origin outside serialized config so unrelated edits cannot persist an inferred
// critical ceiling as if the user had selected it.
const adaptiveRiskConfigs = new WeakSet<BrainConfig>();
const productDefaultConfigs = new WeakSet<BrainConfig>();
export const hasBrainProductDefaults = (config: BrainConfig | undefined): boolean =>
  config !== undefined && productDefaultConfigs.has(config);
export const hasAdaptiveBrainRisk = (config: BrainConfig | undefined): boolean =>
  config !== undefined && adaptiveRiskConfigs.has(config);

/**
 * Product defaults for hosts that want a minimum-human Brain out of the box
 * (CLI/TUI wiring and the standalone WebUI server both apply this before
 * `createBrainRuntime`). Only FILLS GAPS — every explicitly configured field
 * wins, so existing `config.brain` blocks are untouched by updates.
 *
 *   - `models`  → the user's own `fallbackModels` chain (never hardcoded
 *     model ids; every install has different providers). With ≥2 entries the
 *     council auto-derives from the pool, so multi-model users get a council
 *     by default.
 *   - `mode`    → 'headless': decisions never block on a human; the terminal
 *     policy (safe default / deny) is the escalation of last resort.
 *   - `maxAutoRisk` → adaptive: 'all' when a council can convene (critical
 *     questions get a multi-model panel), otherwise 'high' (critical
 *     questions resolve via the conservative terminal policy instead of a
 *     single unchecked model).
 *   - `humanTimeoutMs` → 120s: if the user explicitly switches back to
 *     'interactive', an unanswered prompt still auto-resolves instead of
 *     hanging an unattended run forever. Set `humanTimeoutMs: 0` to restore
 *     the legacy wait-indefinitely behavior.
 *
 * NOTE deliberately NOT persisted anywhere — resolved at boot, so existing
 * users pick these up on update without any config migration/write.
 */
export function resolveBrainConfigDefaults(
  brain: BrainConfig | undefined,
  ctx: BrainDefaultsContext = {},
): BrainConfig {
  const cfg: BrainConfig = { ...(brain ?? {}) };
  productDefaultConfigs.add(cfg);
  if (cfg.models === undefined && ctx.fallbackModels && ctx.fallbackModels.length > 0) {
    cfg.models = [...ctx.fallbackModels];
  }
  const seatCount = cfg.council?.voters?.length ?? cfg.models?.length ?? 0;
  const councilLikely = cfg.council?.enabled ?? seatCount >= 2;
  if (cfg.mode === undefined) cfg.mode = 'headless';
  if (cfg.maxAutoRisk === undefined || (brain && adaptiveRiskConfigs.has(brain))) {
    cfg.maxAutoRisk = councilLikely ? 'all' : 'high';
    adaptiveRiskConfigs.add(cfg);
  }
  if (cfg.humanTimeoutMs === undefined) cfg.humanTimeoutMs = 120_000;
  return cfg;
}
