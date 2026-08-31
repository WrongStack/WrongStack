/**
 * model-router plugin — routes each provider call to a different model
 * based on declarative rules, on the wire.
 *
 * Like `llm-cache`, this registers an `AgentExtension.wrapProviderRunner`
 * (composed around EVERY provider call in the agent loop). Before the
 * request goes out, the plugin evaluates an ordered rule list against
 * the request's size and shape and rewrites `request.model` to the
 * first matching rule's target — e.g. small/tool-free turns to a cheap
 * fast model, large refactors to a capable one.
 *
 * IMPORTANT constraint: the active provider instance is fixed for the
 * session. Rerouting only works among models the CURRENT provider
 * serves (e.g. anthropic `haiku` ↔ `opus`). Routing to a model id the
 * provider doesn't recognize will fail at the provider — keep targets
 * within one provider's catalog.
 *
 * Safety posture: opt-in — loads inert until
 * `config.extensions['model-router'].enabled = true`. A `dryRun` mode
 * (default) only records what it WOULD route without changing the model,
 * so you can observe the routing before trusting it.
 *
 * Config (`config.extensions['model-router']`):
 *
 * ```jsonc
 * {
 *   "enabled": false,
 *   "dryRun": true,             // observe only; do not rewrite the model
 *   "rules": [
 *     { "maxChars": 2000, "hasTools": false, "model": "claude-haiku-4-5" },
 *     { "minChars": 40000, "model": "claude-opus-4-8" }
 *   ]
 * }
 * ```
 *
 * A rule matches when ALL of its present conditions hold. The first
 * matching rule wins; if none match, the request passes through with its
 * original model.
 *
 * Tools:
 *  - `model_router_status` — rules, mode, and per-target routing counts
 *
 * @public
 */
import type { Plugin, PluginAPI } from '@wrongstack/core/types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface RouteRule {
  /** Match when the request's total char size is <= this. */
  maxChars?: number | undefined;
  /** Match when the request's total char size is >= this. */
  minChars?: number | undefined;
  /** Match when the request has (true) / lacks (false) tools. */
  hasTools?: boolean | undefined;
  /** The model id to route matching requests to (required). */
  model: string;
}

interface ModelRouterConfig {
  enabled: boolean;
  dryRun: boolean;
  rules: RouteRule[];
}

const DEFAULTS: ModelRouterConfig = {
  enabled: false,
  dryRun: true,
  rules: [],
};

function readConfig(raw: unknown): ModelRouterConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS, rules: [] };
  const r = raw as Record<string, unknown>;
  const rawRules = r['rules'] ?? r['routes'];
  const rules: RouteRule[] = Array.isArray(rawRules)
    ? (rawRules as unknown[])
        .filter(
          (x): x is Record<string, unknown> =>
            !!x && typeof x === 'object' && typeof (x as { model?: unknown }).model === 'string',
        )
        .map((x) => {
          const rawMax = x['maxChars'] ?? x['max_chars'];
          const rawMin = x['minChars'] ?? x['min_chars'];
          const rawTools = x['hasTools'] ?? x['has_tools'];
          return {
            model: x['model'] as string,
            ...(typeof rawMax === 'number' ? { maxChars: rawMax } : {}),
            ...(typeof rawMin === 'number' ? { minChars: rawMin } : {}),
            ...(typeof rawTools === 'boolean' ? { hasTools: rawTools } : {}),
          };
        })
    : [];
  const rawDryRun = r['dryRun'] ?? r['dry_run'];
  return {
    enabled: r['enabled'] === true,
    dryRun: rawDryRun !== false,
    rules,
  };
}

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface ModelRouterState {
  invocations: number;
  routed: number;
  passthrough: number;
  /** Route counts keyed by "fromModel→toModel". */
  routes: Map<string, number>;
  extensionUnregister: null | (() => void);
}

const state: ModelRouterState = {
  invocations: 0,
  routed: 0,
  passthrough: 0,
  routes: new Map(),
  extensionUnregister: null,
};

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Total character size of the request's actual prompt text (system +
 * message content). Only counts `text` block values and bare-string
 * content — not structural fields like `type`/`role` — so the size is a
 * meaningful proxy for prompt weight.
 */
export function requestCharSize(request: Record<string, unknown>): number {
  let size = 0;
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      size += v.length;
    } else if (Array.isArray(v)) {
      for (const item of v) walk(item);
    } else if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o['text'] === 'string') size += (o['text'] as string).length;
      if (o['content'] !== undefined) walk(o['content']);
      if (o['input'] !== undefined) walk(o['input']);
      if (o['arguments'] !== undefined) walk(o['arguments']);
    }
  };
  walk(request['system']);
  walk(request['messages']);
  return size;
}

/** First rule whose present conditions all hold, or null. */
export function pickRule(rules: RouteRule[], size: number, hasTools: boolean): RouteRule | null {
  for (const rule of rules) {
    if (rule.maxChars !== undefined && size > rule.maxChars) continue;
    if (rule.minChars !== undefined && size < rule.minChars) continue;
    if (rule.hasTools !== undefined && rule.hasTools !== hasTools) continue;
    return rule;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'model-router',
  version: '0.1.0',
  description:
    'Routes each provider call to a different model by declarative size/tool rules (wrapProviderRunner). Opt-in; dry-run by default; routes within the active provider only.',
  apiVersion: '^0.1.10',
  capabilities: { tools: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        default: false,
        description:
          'Master switch. OFF by default because rerouting changes which model serves each turn.',
      },
      dryRun: {
        type: 'boolean',
        default: true,
        description:
          'Observe and count routing decisions without actually rewriting request.model.',
      },
      rules: {
        type: 'array',
        description:
          'Ordered rules. Each has an optional maxChars/minChars/hasTools condition and a required target model. First all-conditions-match wins.',
        items: {
          type: 'object',
          properties: {
            maxChars: { type: 'number', description: 'Match when request char size <= this.' },
            minChars: { type: 'number', description: 'Match when request char size >= this.' },
            hasTools: { type: 'boolean', description: 'Match on tools present/absent.' },
            model: {
              type: 'string',
              description: 'Target model id (must be served by the active provider).',
            },
          },
          required: ['model'],
        },
      },
    },
  },

  setup(api: PluginAPI) {
    // Idempotent re-init (H1 pattern).
    state.invocations = 0;
    state.routed = 0;
    state.passthrough = 0;
    state.routes.clear();
    if (state.extensionUnregister) {
      try {
        state.extensionUnregister();
      } catch {
        // best-effort
      }
      state.extensionUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['model-router']);

    if (cfg.enabled && cfg.rules.length > 0) {
      // Announce participation in the wrap stack so plugin-stack-observer
      // can build a system-prompt summary of who is wrapping what.
      api.emitCustom?.('provider.wrap:loaded', {
        plugin: 'model-router',
        kind: 'routing',
        wraps: ['request'],
      });
      state.extensionUnregister = api.extensions.register({
        name: 'model-router',
        owner: 'model-router',
        async wrapProviderRunner(
          _ctx: unknown,
          request: unknown,
          inner: (c: unknown, r: unknown) => Promise<unknown>,
        ) {
          const req = (request ?? {}) as Record<string, unknown>;
          state.invocations += 1;
          const size = requestCharSize(req);
          const hasTools =
            (Array.isArray(req['tools']) && (req['tools'] as unknown[]).length > 0) ||
            (Array.isArray(req['functions']) && (req['functions'] as unknown[]).length > 0) ||
            (Array.isArray(req['tool_definitions']) && (req['tool_definitions'] as unknown[]).length > 0) ||
            (Array.isArray(req['toolDefinitions']) && (req['toolDefinitions'] as unknown[]).length > 0) ||
            Boolean(req['tool_choice']) ||
            Boolean(req['toolChoice']);
          const rule = pickRule(cfg.rules, size, hasTools);
          const from = typeof req['model'] === 'string' ? (req['model'] as string) : 'unknown';

          if (!rule || rule.model === from) {
            state.passthrough += 1;
            return inner(_ctx, request);
          }

          const routeKey = `${from}→${rule.model}`;
          state.routes.set(routeKey, (state.routes.get(routeKey) ?? 0) + 1);
          state.routed += 1;
          api.metrics.counter('routed', 1, { from, to: rule.model });

          if (cfg.dryRun) {
            // Observe only — leave the model untouched.
            return inner(_ctx, request);
          }
          // Rewrite on a shallow clone so we never mutate the caller's object.
          return inner(_ctx, { ...req, model: rule.model });
        },
      } as never);
    }

    api.tools.register({
      name: 'model_router_status',
      description:
        'Reports model-router state: enabled, dryRun, rules, and per-route counts (from→to).',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          dryRun: cfg.dryRun,
          ruleCount: cfg.rules.length,
          rules: cfg.rules,
          counters: {
            invocations: state.invocations,
            routed: state.routed,
            passthrough: state.passthrough,
          },
          routes: Object.fromEntries(state.routes),
        };
      },
    });

    api.log.info('model-router plugin loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      dryRun: cfg.dryRun,
      rules: cfg.rules.length,
    });
  },

  teardown(api) {
    if (state.extensionUnregister) {
      try {
        state.extensionUnregister();
      } catch {
        // best-effort
      }
      state.extensionUnregister = null;
    }
    const final = {
      invocations: state.invocations,
      routed: state.routed,
      passthrough: state.passthrough,
    };
    state.invocations = 0;
    state.routed = 0;
    state.passthrough = 0;
    state.routes.clear();
    api.log.info('model-router: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message: `model-router: ${state.routed} routed / ${state.passthrough} passthrough of ${state.invocations} call(s)`,
      counters: {
        invocations: state.invocations,
        routed: state.routed,
        passthrough: state.passthrough,
      },
    };
  },
};

export default plugin;
