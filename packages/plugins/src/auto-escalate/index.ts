/**
 * auto-escalate plugin — turns transient provider errors into a graceful
 * model-escalation ladder instead of a hard failure.
 *
 * Registers an `AgentExtension.onError` hook (wired at agent-loop.ts:636).
 * When a provider call fails with a retryable error (overload, rate
 * limit, timeout, 5xx), the plugin asks the agent loop to retry the turn
 * with the NEXT model in a configured escalation ladder — e.g. a busy
 * fast model escalates to a more capable one that may have spare
 * capacity. On a non-retryable error, or once the ladder is exhausted,
 * it steps aside (returns nothing) so the host's built-in error recovery
 * runs unchanged.
 *
 * Loop constraint: the agent loop caps recovery retries at 2 per turn
 * (agent-loop.ts), so at most the first ~2 rungs of the ladder are used
 * before the loop fails. Order the ladder cheapest→most-capable.
 *
 * Safety posture: opt-in — loads inert until
 * `config.extensions['auto-escalate'].enabled = true`. It never forces a
 * `fail`; it only requests retries with a better model, and otherwise
 * defers to the default handler.
 *
 * Config (`config.extensions['auto-escalate']`):
 *
 * ```jsonc
 * {
 *   "enabled": false,
 *   "escalation": ["provider/model-standard", "provider/model-premium"],
 *   "retryablePatterns": ["overload", "rate.?limit", "429", "50[023]", "timeout", "ETIMEDOUT", "ECONNRESET"]
 * }
 * ```
 *
 * Tools:
 *  - `auto_escalate_status` — ladder, patterns, and escalation counters
 *
 * @public
 */
import type { Plugin, PluginAPI } from '@wrongstack/core';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface AutoEscalateConfig {
  enabled: boolean;
  escalation: string[];
  retryablePatterns: RegExp[];
}

const DEFAULT_PATTERNS = [
  'overload',
  'rate.?limit',
  '\\b429\\b',
  '\\b50[023]\\b',
  'timeout',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'temporarily unavailable',
];

function readConfig(raw: unknown): AutoEscalateConfig {
  const base: AutoEscalateConfig = {
    enabled: false,
    escalation: [],
    retryablePatterns: DEFAULT_PATTERNS.map((p) => new RegExp(p, 'i')),
  };
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  const escalation = Array.isArray(r['escalation'])
    ? r['escalation'].filter((m): m is string => typeof m === 'string' && m.length > 0)
    : [];
  const patterns = Array.isArray(r['retryablePatterns'])
    ? r['retryablePatterns']
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .flatMap((p) => {
          try {
            return [new RegExp(p, 'i')];
          } catch {
            return [];
          }
        })
    : base.retryablePatterns;
  return {
    enabled: r['enabled'] === true,
    escalation,
    retryablePatterns: patterns.length > 0 ? patterns : base.retryablePatterns,
  };
}

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface AutoEscalateState {
  errorsSeen: number;
  escalationsRequested: number;
  laddersExhausted: number;
  /** Rungs used this run; reset in beforeRun. */
  runEscalations: number;
  lastEscalation: { to: string; reason: string; when: string } | null;
  extensionUnregister: null | (() => void);
}

const state: AutoEscalateState = {
  errorsSeen: 0,
  escalationsRequested: 0,
  laddersExhausted: 0,
  runEscalations: 0,
  lastEscalation: null,
  extensionUnregister: null,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function isRetryable(text: string, patterns: RegExp[]): boolean {
  return patterns.some((re) => re.test(text));
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'auto-escalate',
  version: '0.1.0',
  description:
    'On retryable provider errors, retries the turn with the next model in an escalation ladder (onError). Opt-in; defers to default recovery otherwise.',
  apiVersion: '^0.1.10',
  capabilities: { tools: true },
  defaultConfig: { enabled: false, escalation: [], retryablePatterns: DEFAULT_PATTERNS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        default: false,
        description: 'Master switch. OFF by default because it changes error-recovery behavior.',
      },
      escalation: {
        type: 'array',
        items: { type: 'string' },
        default: [],
        description:
          'Ordered model ids (cheapest→most-capable) to retry with on successive retryable errors.',
      },
      retryablePatterns: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Case-insensitive regexes; an error whose text matches any is treated as retryable.',
      },
    },
  },

  setup(api: PluginAPI) {
    // Idempotent re-init (H1 pattern).
    state.errorsSeen = 0;
    state.escalationsRequested = 0;
    state.laddersExhausted = 0;
    state.runEscalations = 0;
    state.lastEscalation = null;
    if (state.extensionUnregister) {
      try {
        state.extensionUnregister();
      } catch {
        // best-effort
      }
      state.extensionUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['auto-escalate']);

    if (cfg.enabled && cfg.escalation.length > 0) {
      state.extensionUnregister = api.extensions.register({
        name: 'auto-escalate',
        owner: 'auto-escalate',
        // Fresh run → reset the ladder position.
        beforeRun() {
          state.runEscalations = 0;
        },
        onError(_ctx: unknown, err: unknown, phase: unknown) {
          if (phase !== 'provider') return;
          state.errorsSeen += 1;
          const text = errorText(err);
          if (!isRetryable(text, cfg.retryablePatterns)) return;
          if (state.runEscalations >= cfg.escalation.length) {
            state.laddersExhausted += 1;
            return; // ladder spent → let the default handler decide
          }
          const nextModel = cfg.escalation[state.runEscalations] as string;
          state.runEscalations += 1;
          state.escalationsRequested += 1;
          state.lastEscalation = {
            to: nextModel,
            reason: text.slice(0, 200),
            when: new Date().toISOString(),
          };
          api.metrics.counter('escalations', 1, { to: nextModel });
          api.log.warn('auto-escalate: retrying with escalated model', { to: nextModel });
          return { action: 'retry', model: nextModel };
        },
      } as never);
    }

    api.tools.register({
      name: 'auto_escalate_status',
      description:
        'Reports auto-escalate state: enabled, escalation ladder, and escalation counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          escalation: cfg.escalation,
          retryablePatterns: cfg.retryablePatterns.map((r) => r.source),
          counters: {
            errorsSeen: state.errorsSeen,
            escalationsRequested: state.escalationsRequested,
            laddersExhausted: state.laddersExhausted,
          },
          lastEscalation: state.lastEscalation,
        };
      },
    });

    api.log.info('auto-escalate plugin loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      ladder: cfg.escalation,
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
      errorsSeen: state.errorsSeen,
      escalationsRequested: state.escalationsRequested,
      laddersExhausted: state.laddersExhausted,
    };
    state.errorsSeen = 0;
    state.escalationsRequested = 0;
    state.laddersExhausted = 0;
    state.runEscalations = 0;
    state.lastEscalation = null;
    api.log.info('auto-escalate: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message: `auto-escalate: ${state.escalationsRequested} escalation(s) of ${state.errorsSeen} error(s), ${state.laddersExhausted} ladder(s) exhausted`,
      counters: {
        errorsSeen: state.errorsSeen,
        escalationsRequested: state.escalationsRequested,
        laddersExhausted: state.laddersExhausted,
      },
    };
  },
};

export default plugin;
