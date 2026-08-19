/**
 * Example third-party WrongStack plugin.
 *
 * Demonstrates, in one small file, every extension surface a plugin can
 * participate in:
 *
 *   - a registered TOOL (`example_word_count`) with an input schema,
 *   - a lifecycle HOOK (`PostToolUse` on Write|Edit) that observes edits,
 *   - EVENT BUS subscriptions (`tool.*`) plus a custom plugin event
 *     (`example-word-counter:edit_observed`, emitted via api.emitCustom),
 *   - METRICS (counters/gauge, auto-prefixed `plugin.<name>.…`),
 *   - CONFIG CENTER integration (configSchema validated before setup,
 *     options read from `config.extensions['example-word-counter']`,
 *     hot-reload via api.onConfigChange),
 *   - honest capability declarations (strictly enforced for external
 *     plugins) and a teardown that releases every registration.
 *
 * Load it from the repository root:
 *
 *   wstack plugin add ./examples/07-plugin
 *
 * Plain JavaScript on purpose — third-party plugins do not need a build
 * step. TypeScript authors should use @wrongstack/plugin-sdk instead.
 */

const PLUGIN_NAME = 'example-word-counter';

const DEFAULTS = { minLength: 3, observeEdits: true };

// Module-scope state so teardown()/health() can reach what setup() created
// (the same "H1 audit pattern" the built-in plugins use).
const state = {
  observed: 0,
  totalWords: 0,
  unsubConfig: undefined,
  unsubEvents: undefined,
  releaseHook: undefined,
};

function readConfig(api) {
  const userConfig = api.config.extensions?.[PLUGIN_NAME] ?? {};
  return { ...DEFAULTS, ...userConfig };
}

/** @type {import('@wrongstack/plugin-sdk').Plugin} */
const plugin = {
  name: PLUGIN_NAME,
  version: '1.0.0',
  description: 'Example plugin: word-count tool + edit observer + custom event',
  apiVersion: '^0.1',

  // Honest declarations — external plugins are REJECTED at setup if they
  // touch a surface they did not declare here.
  capabilities: { tools: true, hooks: true },

  defaultConfig: DEFAULTS,
  configSchema: {
    type: 'object',
    properties: {
      minLength: { type: 'number', minimum: 1, description: 'Minimum word count to report' },
      observeEdits: { type: 'boolean', description: 'Count words in Write/Edit tool outputs' },
    },
    additionalProperties: false,
  },
  configFields: {
    minLength: { lifecycle: 'hot', description: 'Applies to the next tool call' },
    observeEdits: { lifecycle: 'hot' },
  },

  async setup(api) {
    let cfg = readConfig(api);

    // ── Tool: available to the agent like any built-in tool ───────────────
    api.tools.register({
      name: 'example_word_count',
      description: 'Count words in a text (example third-party plugin tool)',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      permission: 'auto',
      riskTier: 'safe',
      mutating: false,
      category: 'Examples',
      async execute(input) {
        const words = input.text.split(/\s+/).filter((w) => w.length >= cfg.minLength);
        state.totalWords += words.length;
        api.metrics.counter('words_counted', 1);
        api.metrics.gauge('total_words', state.totalWords);
        return {
          words: words.length,
          hint: `counted ${words.length} words (minLength=${cfg.minLength})`,
        };
      },
    });

    // ── Lifecycle hook: observe successful Write/Edit tool calls ──────────
    if (cfg.observeEdits) {
      state.releaseHook = api.registerHook(
        'PostToolUse',
        'write|edit',
        async (input) => {
          state.observed += 1;
          api.metrics.counter('edits_observed', 1);
          // Custom events follow the '<pluginName>:<event>' convention and
          // are visible to wildcard subscribers (onPattern('example-*')).
          api.emitCustom('example-word-counter:edit_observed', {
            tool: input?.tool_name,
            observed: state.observed,
          });
          // PostToolUse hooks may inject model-visible context.
          return { additionalContext: `[${PLUGIN_NAME}] observed edit #${state.observed}` };
        },
        { name: PLUGIN_NAME, background: true },
      );
    }

    // ── Event bus: observe every tool completion (fire-and-forget) ────────
    state.unsubEvents = api.onPattern('tool.*', (event) => {
      if (event === 'tool.completed') api.metrics.counter('tool_events_seen', 1);
    });

    // ── Config center: hot-reload our own options ─────────────────────────
    state.unsubConfig = api.onConfigChange((next) => {
      cfg = { ...DEFAULTS, ...(next.extensions?.[PLUGIN_NAME] ?? {}) };
      api.log.info(`[${PLUGIN_NAME}] config hot-reloaded (minLength=${cfg.minLength})`);
    });
  },

  async teardown() {
    // Release everything setup acquired — the host enforces a 10 s budget.
    state.releaseHook?.();
    state.unsubEvents?.();
    state.unsubConfig?.();
    state.releaseHook = undefined;
    state.unsubEvents = undefined;
    state.unsubConfig = undefined;
  },

  async health() {
    return {
      ok: true,
      message: `observed ${state.observed} edits, counted ${state.totalWords} words`,
    };
  },
};

export default plugin;
