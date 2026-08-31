/**
 * plugin-stack-observer — observability over the providerRunner wrap stack.
 *
 * Several official plugins (llm-cache, model-router, prompt-firewall,
 * token-throttle) register `AgentExtension.wrapProviderRunner` to
 * intercept every provider call. The runtime composes them in
 * registration order — but until now there was no way for an operator
 * (or the LLM itself) to see WHICH wraps are active in what order.
 *
 * Each wrap plugin emits `customEvent('provider.wrap:loaded', …)` on
 * setup. This plugin subscribes via `onPattern('provider.wrap:loaded')`
 * and:
 *
 *   1. Builds an in-memory stack (preserves emission order)
 *   2. Registers a system-prompt contributor that, when any wraps are
 *      present, emits a compact one-line block listing them. The LLM
 *      sees who is wrapping what, in registration order — making the
 *      stack visible without /diag round-trips.
 *
 * Disabled by default (enabled=false) because not every user wants
 * the LLM to be aware of the wrap stack. The plugin_stack tool is
 * always registered so operators can read the stack at runtime
 * regardless of the contributor setting.
 *
 * Tools registered:
 *  - plugin_stack_status : Read the active wrap stack + load order
 *
 * @public
 */
import type { Plugin } from '@wrongstack/core/types';
import { releaseHandle } from '../runtime/index.js';

interface WrapEntry {
  plugin: string;
  kind: string;
  wraps: string[];
  /** ms since epoch when the wrap was registered (helps ordering). */
  loadedAt: number;
}

interface PluginStackObserverState {
  wraps: WrapEntry[];
  /** Times a system-prompt contributor emitted (for health()). */
  contributions: number;
  /** Custom event listener handle for teardown/reload. */
  patternUnregister: (() => void) | null;
  /** System prompt contributor unregister handle. */
  contributorUnregister: (() => void) | null;
}

const state: PluginStackObserverState = {
  wraps: [],
  contributions: 0,
  patternUnregister: null,
  contributorUnregister: null,
};

function clearObserverState(): void {
  if (state.patternUnregister) {
    try {
      state.patternUnregister();
    } catch {
      // best-effort
    }
    state.patternUnregister = null;
  }
  state.contributorUnregister = releaseHandle(state.contributorUnregister);
  state.wraps = [];
  state.contributions = 0;
}

const PLUGIN: Plugin = {
  name: 'plugin-stack-observer',
  version: '0.1.0',
  description:
    'Observes the wrapProviderRunner stack and exposes it to operators (plugin_stack_status) and, optionally, to the LLM (system-prompt contributor).',
  apiVersion: '^0.1.10',
  capabilities: { tools: true },
  defaultConfig: {
    enabled: true,
    /** Inject the stack into the LLM's system prompt. */
    injectIntoSystemPrompt: false,
  },
  configSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        default: true,
        description: 'Master switch. When false, no events are collected.',
      },
      injectIntoSystemPrompt: {
        type: 'boolean',
        default: false,
        description:
          'When true, the active wrap stack is included as a TextBlock in every system-prompt build so the LLM knows who is wrapping its provider calls.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern): unregister old event listeners before
    // clearing state so reload cannot leave stale callbacks attached.
    clearObserverState();

    const cfg = readConfig(api.config.extensions?.['plugin-stack-observer']);

    if (!cfg.enabled) {
      api.log.info('plugin-stack-observer loaded (disabled)');
      return;
    }

    // Subscribe to the wrap-loaded announcements from llm-cache,
    // model-router, prompt-firewall, token-throttle. Using
    // onPattern because the event name is a custom event not in the
    // typed EventMap (the API doc explicitly recommends onPattern
    // for plugin-originated events).
    state.patternUnregister = api.onPattern(
      'provider.wrap:loaded',
      (_eventName: string, payload: unknown) => {
        const p = (payload ?? {}) as Partial<WrapEntry>;
        if (typeof p.plugin !== 'string' || p.plugin.length === 0) return;
        const wraps = Array.isArray(p.wraps)
          ? p.wraps.filter((w): w is string => typeof w === 'string')
          : [];
        const kind = typeof p.kind === 'string' ? p.kind : 'unknown';
        state.wraps = state.wraps.filter((w) => w.plugin !== p.plugin);
        state.wraps.push({
          plugin: p.plugin,
          kind,
          wraps,
          loadedAt: Date.now(),
        });
        api.metrics.counter('wrap_loaded');
      },
    );

    state.contributorUnregister = releaseHandle(state.contributorUnregister);
    if (cfg.injectIntoSystemPrompt) {
      // Register a system-prompt contributor that returns a TextBlock
      // listing the active wrap stack. Runs on every system-prompt
      // build, but contributes an empty/no-op block when no wraps
      // are loaded so the cost is negligible.
      state.contributorUnregister = api.registerSystemPromptContributor(async () => {
        if (state.wraps.length === 0) return [];
        state.contributions += 1;
        api.metrics.counter('system_prompt_contribution');
        const lines = state.wraps.map(
          (w, i) => `${i + 1}. ${w.plugin} [${w.kind}] wraps: ${w.wraps.join(', ')}`,
        );
        return [
          {
            type: 'text',
            text:
              `[wrapProviderRunner stack — registration order]\n` +
              `The following plugins wrap every LLM provider call in this order:\n` +
              lines.join('\n') +
              `\nAny failure or latency above is attributable to one of the above.`,
          },
        ];
      });
    }

    // --- plugin_stack_status tool ---
    api.tools.register({
      name: 'plugin_stack_status',
      description:
        'Returns the active wrapProviderRunner stack: plugin names, kinds, what they wrap, and registration order.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          injectIntoSystemPrompt: cfg.injectIntoSystemPrompt,
          wrapCount: state.wraps.length,
          wraps: state.wraps,
          contributions: state.contributions,
        };
      },
    });

    api.log.info('plugin-stack-observer loaded', {
      enabled: cfg.enabled,
      injectIntoSystemPrompt: cfg.injectIntoSystemPrompt,
    });
  },

  teardown(api) {
    const final = {
      wrapCount: state.wraps.length,
      contributions: state.contributions,
    };
    clearObserverState();
    api.log.info('plugin-stack-observer: teardown complete', { final });
  },

  async health() {
    const stack =
      state.wraps.length === 0 ? 'no wraps active' : state.wraps.map((w) => w.plugin).join(' → ');
    return {
      ok: true,
      message: `plugin-stack-observer: ${state.wraps.length} wrap(s) loaded [${stack}]`,
      wrapCount: state.wraps.length,
      contributions: state.contributions,
      wraps: state.wraps,
    };
  },
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface PluginStackObserverConfig {
  enabled: boolean;
  injectIntoSystemPrompt: boolean;
}

function readConfig(raw: unknown): PluginStackObserverConfig {
  if (!raw || typeof raw !== 'object') return { enabled: true, injectIntoSystemPrompt: false };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] !== false,
    injectIntoSystemPrompt:
      r['injectIntoSystemPrompt'] === true || r['inject_into_system_prompt'] === true,
  };
}

export default PLUGIN;
