/**
 * error-lens plugin — turns noisy failure output into a compact,
 * actionable digest.
 *
 * When a shell command fails, the model gets a wall of stderr: full
 * stack traces, npm noise, repeated frames. A `PostToolUse` hook on
 * `bash|exec` parses the failure and injects a short digest via
 * `additionalContext`:
 *
 *  - the error type + message line (TypeError, ENOENT, AssertionError…)
 *  - up to `maxFrames` source locations (`file:line`), *project frames
 *    first* (node_modules/internal frames are de-prioritized)
 *  - a repeat marker when the same failure was already seen, so the
 *    model notices "this is the SAME error as before"
 *
 * Recognized trace formats: Node/V8 (`at fn (file:line:col)`), Python
 * (`File "x.py", line 12`), tsc/vitest (`file.ts:12:5`), Rust
 * (`--> src/main.rs:4:5`), Go (`file.go:12 +0x…`).
 *
 * A ring of recent failures is queryable via `error_lens_history` —
 * useful for "what have we broken so far this session?".
 *
 * Config (`config.extensions['error-lens']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "maxFrames": 5,        // source locations per digest
 *   "historySize": 20,     // failures kept for error_lens_history
 *   "minOutputChars": 200, // don't digest tiny outputs (already readable)
 *   "aiHints": false,      // ask the LLM (api.llm) for a one-line fix hint
 *   "llm": { "provider": "", "model": "" }  // optional override for the hint model
 * }
 * ```
 *
 * With `aiHints: true` and a host that wires `api.llm`, each NEW failure
 * digest is enriched with a one-line fix hint from the configured LLM
 * (per-plugin `llm.provider`/`llm.model` override the session default).
 * Hint failures are swallowed — the digest always lands.
 *
 * Toggle off with `{ "name": "error-lens", "enabled": false }` in
 * `config.plugins`, or `"enabled": false` in the options above.
 *
 * @public
 */
import type { Plugin } from '@wrongstack/core';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

export interface FailureRecord {
  when: string;
  tool: string;
  command: string | null;
  errorLine: string | null;
  frames: string[];
  repeats: number;
}

interface ErrorLensState {
  history: FailureRecord[];
  invocations: number;
  digestsInjected: number;
  repeatsDetected: number;
  aiHintsProvided: number;
  aiHintErrors: number;
  hookUnregister: null | (() => void);
}

const state: ErrorLensState = {
  history: [],
  invocations: 0,
  digestsInjected: 0,
  repeatsDetected: 0,
  aiHintsProvided: 0,
  aiHintErrors: 0,
  hookUnregister: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface ErrorLensConfig {
  enabled: boolean;
  maxFrames: number;
  historySize: number;
  minOutputChars: number;
  aiHints: boolean;
}

const DEFAULTS: ErrorLensConfig = {
  enabled: true,
  maxFrames: 5,
  historySize: 20,
  minOutputChars: 200,
  aiHints: false,
};

function readConfig(raw: unknown): ErrorLensConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  return {
    enabled: r['enabled'] !== false,
    maxFrames:
      typeof r['maxFrames'] === 'number' && r['maxFrames'] >= 1 && r['maxFrames'] <= 20
        ? r['maxFrames']
        : DEFAULTS.maxFrames,
    historySize:
      typeof r['historySize'] === 'number' && r['historySize'] >= 1 && r['historySize'] <= 200
        ? r['historySize']
        : DEFAULTS.historySize,
    minOutputChars:
      typeof r['minOutputChars'] === 'number' && r['minOutputChars'] >= 0
        ? r['minOutputChars']
        : DEFAULTS.minOutputChars,
    aiHints: r['aiHints'] === true,
  };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const ERROR_LINE_PATTERNS = [
  // JS/TS: "TypeError: x is not a function", "Error: ENOENT: no such file"
  /^[ \t]*(?:Uncaught )?((?:[A-Z][a-zA-Z]*)?(?:Error|Exception|AssertionError)[^\n]*)/m,
  // Node errno style: "ENOENT: no such file or directory"
  /^[ \t]*((?:ENOENT|EACCES|EADDRINUSE|ECONNREFUSED|ETIMEDOUT|EPERM|ENOTEMPTY)[^\n]*)/m,
  // Python: "ValueError: invalid literal ..."
  /^([A-Z][a-zA-Z]*(?:Error|Exception|Warning): [^\n]*)/m,
  // Rust panic: "thread 'main' panicked at ..."
  /^(thread '[^']*' panicked at [^\n]*)/m,
  // Go panic: "panic: runtime error: ..."
  /^(panic: [^\n]*)/m,
  // Generic FAIL lines from test runners.
  /^[ \t]*((?:FAIL|✗|×)[ \t]+[^\n]{5,})/m,
];

const FRAME_PATTERNS: RegExp[] = [
  // Node/V8: "at fn (path/file.ts:12:5)" or "at path/file.ts:12:5"
  /\bat\s+(?:[^(\n]+\()?([^()\n:]+:\d+)(?::\d+)?\)?/g,
  // Python: File "path/file.py", line 12
  /File "([^"]+)", line (\d+)/g,
  // tsc/vitest/eslint bare: "src/foo.ts:12:5" (require a path-ish prefix)
  /(?:^|[ \t(])([A-Za-z0-9_./\\-]+\.[a-z]{1,4}:\d+)(?::\d+)?/gm,
  // Rust: "--> src/main.rs:4:5"
  /-->\s+([^\s:]+:\d+)/g,
];

/** Extract the first recognizable error line from tool output. */
export function extractErrorLine(output: string): string | null {
  for (const re of ERROR_LINE_PATTERNS) {
    const m = re.exec(output);
    if (m?.[1]) return m[1].trim().slice(0, 300);
  }
  return null;
}

/**
 * Extract source locations (`file:line`) from tool output.
 * Project frames (not node_modules / internal) are ordered first,
 * duplicates removed, capped at `maxFrames`.
 */
export function extractFrames(output: string, maxFrames: number): string[] {
  const seen = new Set<string>();
  const project: string[] = [];
  const vendor: string[] = [];
  for (const re of FRAME_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null = re.exec(output);
    while (m !== null) {
      // Python pattern has file + line in separate groups.
      const frame = m[2] !== undefined ? `${m[1]}:${m[2]}` : (m[1] ?? '');
      const cleaned = frame.replace(/\\/g, '/').trim();
      if (cleaned && !seen.has(cleaned)) {
        seen.add(cleaned);
        const isVendor =
          cleaned.includes('node_modules/') ||
          cleaned.startsWith('node:') ||
          cleaned.includes('internal/');
        (isVendor ? vendor : project).push(cleaned);
      }
      m = re.exec(output);
    }
  }
  return [...project, ...vendor].slice(0, maxFrames);
}

function failureKey(errorLine: string | null, frames: string[]): string {
  return `${errorLine ?? ''}|${frames[0] ?? ''}`;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'error-lens',
  version: '0.1.0',
  description:
    'Distills failed command output into a compact digest (error line + project stack frames) and flags repeated failures',
  apiVersion: '^0.1.10',
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      maxFrames: {
        type: 'number',
        minimum: 1,
        maximum: 20,
        default: 5,
        description: 'Source locations included per digest.',
      },
      historySize: {
        type: 'number',
        minimum: 1,
        maximum: 200,
        default: 20,
        description: 'Failures kept for error_lens_history.',
      },
      minOutputChars: {
        type: 'number',
        minimum: 0,
        default: 200,
        description: 'Outputs shorter than this are not digested (already readable).',
      },
      aiHints: {
        type: 'boolean',
        default: false,
        description:
          'Enrich each NEW failure digest with a one-line fix hint from the LLM (api.llm). ' +
          'Provider/model follow config.extensions["error-lens"].llm, then the session default.',
      },
      llm: {
        type: 'object',
        description: 'Optional { provider, model } override for AI hints.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.history = [];
    state.invocations = 0;
    state.digestsInjected = 0;
    state.repeatsDetected = 0;
    state.aiHintsProvided = 0;
    state.aiHintErrors = 0;
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['error-lens']);

    const hook = async (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }) => {
      if (!cfg.enabled) return;
      state.invocations += 1;
      const result = input.toolResult;
      if (!result) return;
      const output = result.content ?? '';

      // Only digest failures. A non-error result that *contains* a
      // stack trace (e.g. `cat error.log`) is data, not a failure.
      if (!result.isError) return;
      if (output.length < cfg.minOutputChars) return;

      const errorLine = extractErrorLine(output);
      const frames = extractFrames(output, cfg.maxFrames);
      if (!errorLine && frames.length === 0) return;

      const key = failureKey(errorLine, frames);
      const previous = state.history.find((h) => failureKey(h.errorLine, h.frames) === key);
      let repeats = 1;
      let isNewFailure = false;
      if (previous) {
        previous.repeats += 1;
        previous.when = new Date().toISOString();
        repeats = previous.repeats;
        state.repeatsDetected += 1;
        api.metrics.counter('repeats');
      } else {
        isNewFailure = true;
        const ti = (input.toolInput ?? {}) as Record<string, unknown>;
        state.history.push({
          when: new Date().toISOString(),
          tool: input.toolName ?? 'unknown',
          command: typeof ti['command'] === 'string' ? ti['command'].slice(0, 200) : null,
          errorLine,
          frames,
          repeats: 1,
        });
        if (state.history.length > cfg.historySize) {
          state.history.splice(0, state.history.length - cfg.historySize);
        }
      }

      state.digestsInjected += 1;
      api.metrics.counter('digests');

      const parts: string[] = ['error-lens digest:'];
      if (errorLine) parts.push(`  error: ${errorLine}`);
      if (frames.length > 0) parts.push(`  frames: ${frames.join('  ')}`);
      if (repeats > 1) {
        parts.push(
          `  NOTE: this is the SAME failure as ${repeats - 1} earlier attempt(s) — the previous fix did not work; try a different approach.`,
        );
      }

      // ── Optional AI fix hint via the host's LLM (api.llm) ─────────────
      // Only for NEW failures (a repeat means the model already has the
      // hint), and strictly best-effort — a hint failure never blocks the
      // digest. Provider/model resolution (per-plugin llm config → session
      // default) is handled inside api.llm.
      if (cfg.aiHints && isNewFailure && api.llm) {
        try {
          const hint = await api.llm.complete(
            `A command failed with this error:\n${errorLine ?? '(no error line)'}\n` +
              (frames.length > 0 ? `Top stack frames: ${frames.join(', ')}\n` : '') +
              'Reply with ONE short sentence suggesting the most likely fix. No preamble.',
            { system: 'You are a terse debugging assistant.', maxTokens: 100 },
          );
          const text = hint.text.trim();
          if (text) {
            state.aiHintsProvided += 1;
            api.metrics.counter('ai_hints');
            parts.push(`  hint (${hint.model}): ${text.slice(0, 300)}`);
          }
        } catch {
          state.aiHintErrors += 1;
        }
      }

      return { additionalContext: parts.join('\n') };
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'bash|exec', hook as never);

    // ── error_lens_history tool ───────────────────────────────────────
    api.tools.register({
      name: 'error_lens_history',
      description:
        'Lists failures observed this session (error line, source frames, repeat counts). Useful to review what has been breaking.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max entries to return (default 10).' },
        },
      },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute(input: { limit?: number | undefined }) {
        const limit =
          typeof input.limit === 'number' && input.limit >= 1 ? Math.floor(input.limit) : 10;
        return {
          ok: true,
          enabled: cfg.enabled,
          aiHints: cfg.aiHints,
          llmAvailable: Boolean(api.llm),
          failures: [...state.history].reverse().slice(0, limit),
          counters: {
            invocations: state.invocations,
            digestsInjected: state.digestsInjected,
            repeatsDetected: state.repeatsDetected,
            aiHintsProvided: state.aiHintsProvided,
            aiHintErrors: state.aiHintErrors,
          },
        };
      },
    });

    api.log.info('error-lens plugin loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      maxFrames: cfg.maxFrames,
    });
  },

  teardown(api) {
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }
    const final = {
      invocations: state.invocations,
      digestsInjected: state.digestsInjected,
      repeatsDetected: state.repeatsDetected,
      aiHintsProvided: state.aiHintsProvided,
    };
    state.history = [];
    state.invocations = 0;
    state.digestsInjected = 0;
    state.repeatsDetected = 0;
    state.aiHintsProvided = 0;
    state.aiHintErrors = 0;
    api.log.info('error-lens: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message: `error-lens: ${state.digestsInjected} digest(s) injected, ${state.repeatsDetected} repeat(s) flagged, ${state.history.length} failure(s) in history`,
      counters: {
        invocations: state.invocations,
        digestsInjected: state.digestsInjected,
        repeatsDetected: state.repeatsDetected,
      },
    };
  },
};

export default plugin;
