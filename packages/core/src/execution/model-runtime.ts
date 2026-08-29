/**
 * Model-runtime resolver + request-pipeline middleware.
 *
 * Maps the shared `Config.modelRuntime` settings into the per-request
 * `Request.reasoning` and `Request.cache` fields, gated by the active model's
 * `reasoningConfig` capabilities so unsupported values are omitted (and
 * surfaced as warnings) instead of triggering provider 400s.
 *
 * Wired once at boot (REPL/TUI/WebUI all go through the same `request`
 * pipeline) — see `installModelRuntimeMiddleware()`. UIs only need to mutate
 * `Config.modelRuntime` (and persist) for the change to take effect on the next
 * request.
 */
import type {
  Capabilities,
  ReasoningConfig,
  ReasoningRequest,
  Request,
  RequestCacheControl,
} from '../types/provider.js';
import type { ModelRuntimeConfig, ModelRuntimeParametersConfig } from '../types/config.js';
import {
  conversationBoundToRequest,
  inheritRequestConversation,
} from '../core/request-conversation-binding.js';
import { providerBoundToRequest } from '../core/request-provider-binding.js';

export interface ResolvedModelRuntime {
  reasoning: Request['reasoning'];
  cache: Request['cache'];
  /** Resolved generation parameters (topK, frequencyPenalty, etc.). */
  parameters: Partial<Request> | undefined;
  /** Human-readable warnings for settings that were ignored for this model. */
  warnings: string[];
}

/**
 * Overlay a scoped runtime override (for example a subagent role matrix entry)
 * on top of the session-wide runtime settings. Nested objects merge so a role
 * can set only `reasoning.effort` without losing the leader's cache TTL or
 * other gated parameters.
 */
export function mergeModelRuntime(
  base: ModelRuntimeConfig | undefined,
  override: ModelRuntimeConfig | undefined,
): ModelRuntimeConfig | undefined {
  if (!base) return override;
  if (!override) return base;
  return {
    ...base,
    ...override,
    reasoning:
      base.reasoning || override.reasoning
        ? { ...base.reasoning, ...override.reasoning }
        : undefined,
    cache:
      base.cache || override.cache
        ? { ...base.cache, ...override.cache }
        : undefined,
    parameters:
      base.parameters || override.parameters
        ? { ...base.parameters, ...override.parameters }
        : undefined,
  };
}

/**
 * Resolve user-facing runtime settings into request fields for a specific
 * model capability profile. Pure function — safe to unit-test without a
 * provider or event bus.
 *
 * @param settings   `Config.modelRuntime` (may be undefined → no-op)
 * @param reasoning  The model's `reasoningConfig`, or undefined when unknown.
 *                   When undefined the resolver is conservative: explicit
 *                   on/off is suppressed (provider default wins) and effort is
 *                   dropped, because we cannot tell whether the model will
 *                   accept the fields.
 */
export function resolveModelRuntime(
  settings: ModelRuntimeConfig | undefined,
  reasoning: ReasoningConfig | undefined,
  capabilities?: Capabilities | undefined,
): ResolvedModelRuntime {
  const warnings: string[] = [];
  if (!settings) {
    return { reasoning: undefined, cache: undefined, parameters: undefined, warnings };
  }

  const reasoningField = resolveReasoningForRequest(settings, reasoning, warnings);
  const cacheField = resolveCacheForRequest(settings, warnings);
  const paramsField = resolveParametersForRequest(settings.parameters, capabilities, warnings);

  return {
    reasoning: reasoningField,
    cache: cacheField,
    parameters: paramsField,
    warnings,
  };
}

export function resolveReasoningForRequest(
  settings: ModelRuntimeConfig,
  rc: ReasoningConfig | undefined,
  warnings: string[],
): Request['reasoning'] {
  const cfg = settings.reasoning;
  if (!cfg) return undefined;

  // Capability-unknown: be conservative. Sending explicit enabled/disabled to
  // a model that doesn't understand the field is a common source of 400s
  // (e.g. always-on Kimi code models reject `thinking: { type: "disabled" }`).
  // Unknown-capability cases drop the field silently — the user has no
  // actionable response, and the resolver already omits the value to avoid
  // provider errors. Surfacing a warning every request would be pure noise.
  const capKnown = rc !== undefined;
  const supportsReasoning = rc ? rc.default !== 'disabled' || rc.disableSupported || rc.effortSupported !== false : false;

  const out: ReasoningRequest = {};

  if (cfg.mode === 'off') {
    if (capKnown && rc?.disableSupported) {
      out.enabled = false;
    } else if (capKnown && rc && rc.default === 'always_on') {
      warnings.push(
        'reasoning "off" requested, but this model has thinking always on; the disable field was omitted to avoid a provider error.',
      );
    } else if (capKnown && rc && !rc.disableSupported) {
      warnings.push('reasoning "off" requested, but this model does not support disabling thinking; the setting was omitted.');
    }
    // capKnown === false: silently omit; field is dropped to avoid 400s.
  } else if (cfg.mode === 'on') {
    if (!capKnown) {
      // Silently omit; cannot verify the model accepts an explicit "on".
    } else if (!supportsReasoning && rc?.default === 'disabled') {
      warnings.push('reasoning "on" requested, but this model has reasoning disabled by default and does not advertise support; the setting was omitted.');
    } else {
      out.enabled = true;
    }
  }
  // mode 'auto' → never send explicit enabled/disabled; provider default wins.

  const effort = cfg.effort;
  if (effort !== undefined) {
    if (!capKnown) {
      // Capability-unknown: silently omit. The resolver cannot tell whether
      // the model accepts the field, so it drops the value rather than guess.
    } else if (rc?.effortSupported === false) {
      warnings.push(
        `reasoning effort "${effort}" requested, but this model does not support effort control; the setting was omitted.`,
      );
    } else if (
      rc?.effortSupported === true &&
      rc.effortLevels.length > 0 &&
      !rc.effortLevels.includes(effort)
    ) {
      warnings.push(
        `reasoning effort "${effort}" not supported by this model (supported: ${rc.effortLevels.join(', ')}); the setting was omitted.`,
      );
    } else {
      // Either the documented levels include this effort, or the model's
      // effort vocabulary is undocumented (`effortSupported === undefined`).
      // Forward it: every wire adapter applies its own transport-level gating
      // (allowlist, mapping, or omit), so an undocumented model can only
      // match-or-omit — never receive a field shape it did not advertise.
      out.effort = effort;
    }
  }

  if (cfg.preserve !== undefined) {
    if (capKnown && rc && rc.preserveThinking !== 'unsupported') {
      out.preserve = cfg.preserve;
    } else if (capKnown && cfg.preserve) {
      // `false` already matches the effective behaviour of a model that
      // cannot preserve thinking. Only an enabled request is unsupported and
      // actionable; warning for an explicit `false` would be both misleading
      // and noisy because this resolver runs for every model request.
      warnings.push('reasoning preserve requested, but this model does not support preserved thinking; the setting was omitted.');
    }
    // Unknown capabilities: preserve is a soft, widely-supported field, so we
    // drop it rather than guess — provider behaviour varies too much.
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export function resolveCacheForRequest(
  settings: ModelRuntimeConfig,
  _warnings: string[],
): Request['cache'] {
  const out: RequestCacheControl = {};
  if (settings.cache?.ttl !== undefined) out.ttl = settings.cache.ttl;
  if (settings.cache?.geminiExplicit === true) out.geminiExplicit = true;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Map the user-facing `ModelRuntimeParametersConfig` onto `Request` fields,
 * gated by the active model's `Capabilities`. Parameters whose capability
 * flag is false (or unknown) are silently omitted so unsupported models
 * never receive fields they'd reject.
 */
export function resolveParametersForRequest(
  params: ModelRuntimeParametersConfig | undefined,
  caps: Capabilities | undefined,
  _warnings: string[],
): Partial<Request> | undefined {
  if (!params) return undefined;

  const out: Partial<Request> = {};

  if (params.topK !== undefined && caps?.topK !== false) {
    out.topK = params.topK;
  }
  if (params.frequencyPenalty !== undefined && caps?.frequencyPenalty !== false) {
    out.frequencyPenalty = params.frequencyPenalty;
  }
  if (params.presencePenalty !== undefined && caps?.presencePenalty !== false) {
    out.presencePenalty = params.presencePenalty;
  }
  if (params.seed !== undefined && caps?.seed !== false) {
    out.seed = params.seed;
  }
  if (params.user !== undefined) {
    out.user = params.user;
  }
  if (params.logprobs !== undefined && caps?.logprobs !== false) {
    out.logprobs = params.logprobs;
    if (params.topLogprobs !== undefined) {
      out.topLogprobs = params.topLogprobs;
    }
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export interface ModelRuntimeMiddlewareOptions {
  /** Provider id of the active model, for logging/diagnostics only. */
  providerId?: string | undefined;
  /** Model id of the active model, for logging/diagnostics only. */
  modelId?: string | undefined;
  /** Current runtime settings. Called per-request so live changes apply. */
  getSettings(): ModelRuntimeConfig | undefined;
  /** Current model capability profile. Called per-request. */
  getReasoningConfig(): ReasoningConfig | undefined;
  /** Current model capabilities for parameter gating. Called per-request. */
  getCapabilities?(): Capabilities | undefined;
  /** Optional sink for suppressed-setting warnings (e.g. emit to event bus). */
  onWarning?: ((message: string) => void) | undefined;
}

/**
 * Build a `request`-pipeline middleware that applies runtime settings. The
 * returned function mutates the outgoing request by overlaying resolved
 * `reasoning` / `cache` fields and generic parameters. Existing fields on
 * the request are preserved only when the resolver produces nothing for
 * that field.
 */
/**
 * Overlay one conversation's reasoning choice on the project settings.
 *
 * Only the reasoning triple is per conversation (`SESSION_SCOPED_PREF_KEYS` in
 * the WebUI server names the same three); cache TTL and generic parameters are
 * project-wide and pass through untouched. A conversation that never chose
 * anything returns the project settings unchanged, which is every
 * single-session host.
 */
function withConversationReasoning(
  settings: ModelRuntimeConfig | undefined,
  meta: Record<string, unknown> | undefined,
): ModelRuntimeConfig | undefined {
  if (!meta) return settings;
  const mode = meta['reasoningMode'];
  const effort = meta['reasoningEffort'];
  const preserve = meta['reasoningPreserve'];
  const scoped: Record<string, unknown> = {};
  if (typeof mode === 'string') scoped.mode = mode;
  // 'auto' is the WebUI "follow the general setting" sentinel, not an effort
  // level: treat it as no conversation-level override so the project-wide
  // effort (or the provider default, when unset) applies.
  if (typeof effort === 'string' && effort !== 'auto') scoped.effort = effort;
  if (typeof preserve === 'boolean') scoped.preserve = preserve;
  if (Object.keys(scoped).length === 0) return settings;
  return {
    ...(settings ?? {}),
    reasoning: { ...(settings?.reasoning ?? {}), ...scoped },
  } as ModelRuntimeConfig;
}

export function applyModelRuntime(
  req: Request,
  opts: ModelRuntimeMiddlewareOptions,
): Request {
  // Reasoning is a PER-CONVERSATION preference — the WebUI writes it to the
  // asking tab's meta — but this middleware only ever read the project config,
  // so whichever tab last changed its effort silently changed everyone's next
  // request. Same shape as the YOLO and auto-compaction fixes: the preference
  // moved to the session, the runtime that APPLIES it stayed process-wide.
  const conversation = conversationBoundToRequest(req);
  const settings = withConversationReasoning(opts.getSettings(), conversation?.meta);
  if (!settings) return req;
  const rc = opts.getReasoningConfig();
  // Capabilities of the provider THIS request is going out on. The option is
  // resolved from the process's live provider, which is the conversation's own
  // for a single-session host and the boot tab's for every other tab.
  const caps = providerBoundToRequest(req)?.capabilities ?? opts.getCapabilities?.();
  const resolved = resolveModelRuntime(settings, rc, caps);
  for (const w of resolved.warnings) opts.onWarning?.(w);

  const next: Request = { ...req };
  inheritRequestConversation(req, next);
  if (resolved.reasoning !== undefined) {
    next.reasoning = resolved.reasoning;
  }
  if (resolved.cache !== undefined) {
    // Merge, not replace: a provider-agnostic cache `key` derived at
    // request-build time (agent-response.ts) must survive the config-driven
    // `ttl` overlay. When no cache config exists, `req.cache.key` is untouched.
    next.cache = { ...next.cache, ...resolved.cache };
  }
  if (resolved.parameters !== undefined) {
    Object.assign(next, resolved.parameters);
  }
  return next;
}
