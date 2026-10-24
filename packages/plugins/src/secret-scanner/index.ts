/**
 * secret-scanner plugin — Pre-tool and post-tool hooks that block, redact,
 * or warn about plaintext credentials flowing into or out of tools.
 *
 * Tools registered:
 * - secret_scanner_status  : Show which patterns are active, recent
 *                            blocks/leaks, and current mode.
 * - secret_scanner_test    : Run the scanner against a user-supplied
 *                            string and report which patterns matched.
 *
 * Hooks registered:
 * - PreToolUse with matcher `bash|pwsh|exec|write|edit|replace|patch` (configurable). Default
 *   action is to BLOCK; the plugin can also auto-redact the offending
 *   fields via `HookOutcome.modifiedInput`.
 * - PostToolUse with matcher `*` (configurable via `postToolUseMatcher`).
 *   Scans tool OUTPUT for secrets that leaked through. Since the tool
 *   has already run, the hook cannot block — instead it injects an
 *   `additionalContext` warning so the LLM knows the output contains
 *   a secret and should NOT echo it, store it, or commit it.
 *
 * Why a separate plugin from the built-in `DefaultSecretScrubber`?
 * The scrubber is *output* sanitization (replace secrets with
 * `[REDACTED:type]` before they leave the system). The scanner is
 * *prevention* (stop the tool from running with a secret in the first
 *   place) + *detection* (flag secrets that leaked through the output).
 * They share the same threat model but act at different points in the
 * pipeline.
 */
import { type Plugin, type PluginAPI, ToolValidationError } from '@wrongstack/contracts/types';
import { releaseHandle } from '../runtime/index.js';
import {
  BASE_PATTERNS,
  buildCombinedRegex,
  type Pattern,
  scannerPatterns,
} from './scanner-patterns.js';
import {
  COMBINED_REGEX,
  findMatches,
  MAX_TOTAL_SCAN_LENGTH,
  redactInput,
  SecretScanTimeoutError,
  scanInput,
  setCombinedRegex,
  TOO_LARGE_MARKER,
} from './secret-scanner-redaction.js';

// ---------------------------------------------------------------------------
// Per-host lifecycle state
// ---------------------------------------------------------------------------

interface SecretScannerState {
  blockCount: number;
  redactCount: number;
  allowCount: number;
  leakCount: number;
  timeoutCount: number;
  lastBlock: null | { toolName: string; matchedTypes: string[]; when: string };
  lastLeak: null | { toolName: string; matchedTypes: string[]; when: string };
  hookUnregister: null | (() => void);
  postHookUnregister: null | (() => void);
}

function createState(): SecretScannerState {
  return {
    blockCount: 0,
    redactCount: 0,
    allowCount: 0,
    /** PostToolUse: secrets detected in tool output. */
    leakCount: 0,
    timeoutCount: 0,
    /** Most recent PreToolUse block — surfaced by `secret_scanner_status`. */
    lastBlock: null as null | {
      toolName: string;
      matchedTypes: string[];
      when: string;
    },
    /** Most recent PostToolUse leak — surfaced by `secret_scanner_status`. */
    lastLeak: null as null | {
      toolName: string;
      matchedTypes: string[];
      when: string;
    },
    /** PreToolUse hook handle so teardown can unregister. */
    hookUnregister: null as null | (() => void),
    /** PostToolUse hook handle so teardown can unregister. */
    postHookUnregister: null as null | (() => void),
  };
}

interface SecretScannerRuntime {
  state: SecretScannerState;
  patterns: Pattern[];
  combinedRegex: RegExp;
  groupIndexes: number[];
}

const runtimes = new WeakMap<PluginAPI, SecretScannerRuntime>();
let latestRuntime: SecretScannerRuntime | undefined;

/** Select the immutable pattern projection captured by one plugin host. */
function activateRuntime(runtime: SecretScannerRuntime): void {
  scannerPatterns.patterns = runtime.patterns;
  setCombinedRegex(runtime.combinedRegex);
  scannerPatterns.groupIndexes = runtime.groupIndexes;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type Mode = 'block' | 'redact' | 'allow';

interface CustomPattern {
  /** Unique identifier for this pattern (used in block reason + redaction label). */
  type: string;
  /** Regex source string (without `/…/g` delimiters). Must be a valid JS regex. */
  regex: string;
  /** Optional human-readable description. */
  description?: string | undefined;
}

interface SecretScannerConfig {
  /** PreToolUse: Tool-name matcher — pipe-delimited case-insensitive list, or '*'. */
  matcher: string;
  /** PostToolUse: Tool-name matcher for output scanning. Default '*' (all tools). */
  postToolUseMatcher: string;
  /** Action when a match is found in tool INPUT (PreToolUse). */
  mode: Mode;
  /** Set to false to short-circuit both hooks entirely (no scanning). */
  enabled: boolean;
  /** User-supplied custom patterns — appended to the 20 built-in patterns at setup() time. */
  customPatterns: CustomPattern[];
}

const DEFAULTS: SecretScannerConfig = {
  // Every built-in tool that runs a command or puts content on disk. Matching
  // is by exact name, so a tool missing here bypasses the gate entirely:
  // `pwsh` (the Windows shell), `exec`, `replace` and `patch` carried the same
  // credential that `bash`/`write`/`edit` blocked.
  matcher: 'bash|pwsh|exec|write|edit|replace|patch',
  postToolUseMatcher: '*',
  mode: 'block',
  enabled: true,
  customPatterns: [],
};

function readConfig(raw: unknown): SecretScannerConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const rawMode =
    typeof (r['mode'] ?? r['action'] ?? r['behavior']) === 'string'
      ? String(r['mode'] ?? r['action'] ?? r['behavior'])
          .trim()
          .toLowerCase()
      : undefined;
  const mode: Mode =
    rawMode === 'redact' || rawMode === 'allow' || rawMode === 'warn'
      ? rawMode === 'warn'
        ? 'allow'
        : (rawMode as Mode)
      : 'block';
  const customPatterns: CustomPattern[] = [];
  const rawCustom = r['customPatterns'] ?? r['custom_patterns'] ?? r['patterns'];
  if (Array.isArray(rawCustom)) {
    for (const entry of rawCustom) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const type = e['type'] ?? e['name'] ?? e['kind'];
      const regex = e['regex'] ?? e['pattern'];
      if (typeof type !== 'string' || typeof regex !== 'string') continue;
      // Validate the regex compiles — skip entries that throw.
      try {
        new RegExp(regex, 'g');
      } catch {
        continue;
      }
      customPatterns.push({
        type,
        regex,
        description: typeof e['description'] === 'string' ? e['description'] : undefined,
      });
    }
  }
  return {
    matcher: typeof r['matcher'] === 'string' ? r['matcher'] : DEFAULTS.matcher,
    postToolUseMatcher:
      typeof (r['postToolUseMatcher'] ?? r['post_tool_use_matcher'] ?? r['outputMatcher']) ===
      'string'
        ? ((r['postToolUseMatcher'] ?? r['post_tool_use_matcher'] ?? r['outputMatcher']) as string)
        : DEFAULTS.postToolUseMatcher,
    mode,
    enabled: r['enabled'] !== false,
    customPatterns,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

function buildHook(
  cfg: SecretScannerConfig,
  log: {
    warn: (msg: string, ...rest: unknown[]) => void;
    info: (msg: string, ...rest: unknown[]) => void;
  },
  runtime: SecretScannerRuntime,
) {
  return (input: {
    toolName?: string | undefined;
    toolInput?: unknown;
  }): {
    decision?: 'block' | 'allow' | undefined;
    reason?: string | undefined;
    modifiedInput?: Record<string, unknown>;
    additionalContext?: string | undefined;
  } | void => {
    activateRuntime(runtime);
    const { state } = runtime;
    if (!cfg.enabled) return;
    const toolName = input.toolName ?? 'unknown';
    let matched: string[] | null;
    try {
      matched = scanInput(input.toolInput);
    } catch (err) {
      if (String(err).includes('ReDoS')) {
        state.timeoutCount += 1;
        const partial =
          err instanceof SecretScanTimeoutError && err.matchedSoFar.length > 0
            ? ` Matched before the budget ran out: ${err.matchedSoFar.join(', ')}.`
            : '';
        return {
          decision: 'block',
          reason: `secret-scanner: ReDoS timeout — regex scan exceeded the wall-clock budget. Fail-closed: treated as a block.${partial}`,
        };
      }
      throw err;
    }
    if (!matched) return;
    // We have at least one match. Branch on mode.
    const summary = matched.join(', ');
    const when = new Date().toISOString();
    if (cfg.mode === 'block') {
      state.blockCount += 1;
      state.lastBlock = { toolName, matchedTypes: matched, when };
      log.warn(`[secret-scanner] blocked ${toolName} — matched: ${summary}`);
      return {
        decision: 'block',
        reason:
          `secret-scanner: refused to run '${toolName}' because the arguments ` +
          `appear to contain plaintext credentials (${summary}). ` +
          `Move the secret to a secret manager, env var, or config file and re-issue the call.`,
      };
    }
    if (cfg.mode === 'redact') {
      const redacted = redactInput(input.toolInput);
      if (
        redacted.ok &&
        redacted.value !== null &&
        typeof redacted.value === 'object' &&
        !Array.isArray(redacted.value)
      ) {
        state.redactCount += 1;
        log.info(`[secret-scanner] redacted ${toolName} — matched: ${summary}`);
        return {
          decision: 'allow',
          modifiedInput: redacted.value as Record<string, unknown>,
          additionalContext: `secret-scanner: redacted ${matched.length} credential pattern(s) from the ${toolName} arguments before execution.`,
        };
      }
      // Redact mode is fail-closed: an oversized/deep input or a non-object
      // tool payload must never pass through under the guise of redaction.
      state.blockCount += 1;
      state.lastBlock = { toolName, matchedTypes: matched, when };
      const detail = !redacted.ok
        ? redacted.reason === 'oversized_input'
          ? 'an input field exceeds the safe scan limit'
          : 'the input exceeds the safe nesting depth'
        : 'the input has a non-object shape';
      return {
        decision: 'block',
        reason: `secret-scanner: cannot safely redact '${toolName}' because ${detail}; refusing to run.`,
      };
    }
    // mode === 'allow' — just count and log, never block.
    state.allowCount += 1;
    log.warn(
      `[secret-scanner] allow-mode: ${toolName} matched ${summary} but mode='allow' lets it through.`,
    );
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// PostToolUse hook — scan tool OUTPUT for leaked secrets
// ---------------------------------------------------------------------------

/**
 * Build a PostToolUse hook that scans the tool's output for secrets.
 *
 * Unlike PreToolUse, the tool has ALREADY run — we cannot block or
 * redact. Instead we inject `additionalContext` so the LLM knows:
 * "the tool output contains a plaintext secret — do NOT echo it,
 * store it, commit it, or send it to a third party."
 *
 * The counter is always bumped regardless of mode — detecting a leak
 * in `allow` mode is still operationally important.
 */
function buildPostHook(
  cfg: SecretScannerConfig,
  log: { warn: (msg: string, ...rest: unknown[]) => void },
  runtime: SecretScannerRuntime,
) {
  return (input: {
    toolName?: string | undefined;
    toolResult?: { content: string; isError: boolean } | undefined;
  }): { additionalContext?: string | undefined } | void => {
    activateRuntime(runtime);
    const { state } = runtime;
    if (!cfg.enabled) return;
    const result = input.toolResult;
    if (!result || typeof result.content !== 'string') return;

    const matched = findMatches(result.content);
    if (matched.length === 0) return;

    const toolName = input.toolName ?? 'unknown';
    const oversized = matched.includes(TOO_LARGE_MARKER);
    const credentialMatches = matched.filter((type) => type !== TOO_LARGE_MARKER);

    // Oversized is a scan classification, not a credential type. If no actual
    // pattern matched, warn that inspection was incomplete without recording a
    // confirmed leak or telling the user to rotate an unknown credential.
    if (oversized && credentialMatches.length === 0) {
      log.warn(
        `[secret-scanner] POST-TOOL UNSCANNABLE: ${toolName} output exceeds ${MAX_TOTAL_SCAN_LENGTH} characters`,
      );
      return {
        additionalContext:
          `\n⚠️ secret-scanner: the output of '${toolName}' exceeds the safe scan limit ` +
          `and could not be inspected for plaintext credentials. Do not treat this output ` +
          `as verified clean; avoid echoing, storing, committing, or transmitting it until ` +
          `it can be reviewed in smaller bounded sections.`,
      };
    }

    // A secret leaked through the tool output. We can't un-run the
    // tool, but we CAN tell the LLM to treat this output as sensitive.
    const summary = credentialMatches.join(', ');
    const when = new Date().toISOString();

    state.leakCount += 1;
    state.lastLeak = { toolName, matchedTypes: credentialMatches, when };

    log.warn(`[secret-scanner] POST-TOOL LEAK: ${toolName} output matched ${summary}`);

    return {
      additionalContext:
        `\n⚠️ secret-scanner: the output of '${toolName}' contains what appears to be ` +
        `plaintext credential(s) (${summary}). Do NOT echo, store, commit, or transmit ` +
        `this value. Treat it as compromised and advise the user to rotate it.`,
    };
  };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'secret-scanner',
  version: '0.1.0',
  description:
    'Pre-tool hook that blocks (or optionally redacts) tools whose arguments contain plaintext credentials',
  apiVersion: '^0.1.10',
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      matcher: {
        type: 'string',
        description: 'PreToolUse: Tool-name matcher (pipe-delimited case-insensitive, or "*")',
      },
      postToolUseMatcher: {
        type: 'string',
        default: '*',
        description:
          'PostToolUse: Tool-name matcher for output leak detection. Default "*" scans all tool outputs.',
      },
      mode: {
        type: 'string',
        enum: ['block', 'redact', 'allow'],
        description:
          'PreToolUse action on a match: "block" refuses the tool call, "redact" rewrites the input with [REDACTED:type], "allow" only logs',
      },
      enabled: { type: 'boolean', default: true },
      customPatterns: {
        type: 'array',
        description:
          'User-supplied custom credential patterns. Each entry is { type: string, regex: string, description?: string }. Appended to the 20 built-in patterns at setup() time.',
        items: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              description: 'Unique identifier (used in block reason + [REDACTED:type] label)',
            },
            regex: {
              type: 'string',
              description:
                'Regex source string (without /…/g delimiters). Must be a valid JS regex.',
            },
            description: { type: 'string', description: 'Optional human-readable description' },
          },
          required: ['type', 'regex'],
        },
        default: [],
      },
    },
  },

  setup(api) {
    // Re-initializing one host replaces only that host's hooks. A second
    // PluginAPI can run concurrently without tearing down the first host.
    const previous = runtimes.get(api);
    if (previous) {
      previous.state.hookUnregister = releaseHandle(previous.state.hookUnregister);
      previous.state.postHookUnregister = releaseHandle(previous.state.postHookUnregister);
    }

    const cfg = readConfig(api.config.extensions?.['secret-scanner']);

    // Rebuild the active pattern set: start from BASE_PATTERNS, then
    // append user-supplied custom patterns. This is idempotent —
    // every setup() call resets to base first, so a reload never
    // accumulates duplicate custom entries.
    scannerPatterns.patterns = [...BASE_PATTERNS];
    for (const cp of cfg.customPatterns) {
      try {
        scannerPatterns.patterns.push({ type: cp.type, regex: new RegExp(cp.regex, 'g') });
      } catch {
        // readConfig already validated; this catch is defensive.
      }
    }
    setCombinedRegex(buildCombinedRegex(scannerPatterns.patterns));
    const runtime: SecretScannerRuntime = {
      state: createState(),
      patterns: scannerPatterns.patterns,
      combinedRegex: COMBINED_REGEX,
      groupIndexes: [...scannerPatterns.groupIndexes],
    };
    runtimes.set(api, runtime);
    latestRuntime = runtime;
    const { state } = runtime;

    const log = {
      warn: (msg: string, ...rest: unknown[]) => api.log.warn(msg, ...rest),
      info: (msg: string, ...rest: unknown[]) => api.log.info(msg, ...rest),
    };

    // Register the PreToolUse hook. registerHook returns an unregister
    // function we keep for teardown.
    const hook = buildHook(cfg, log, runtime);
    state.hookUnregister = api.registerHook('PreToolUse', cfg.matcher, hook, {
      name: 'secret-scanner',
      // Redaction rewrites arguments; block/allow modes must inspect the final
      // result after every mutator has run so a later rewrite cannot smuggle a
      // secret past deterministic enforcement.
      stage: cfg.mode === 'redact' ? 'mutate' : 'validate',
      failurePolicy: 'closed',
      policy: true,
    });

    // Register the PostToolUse hook for output leak detection.
    const postHook = buildPostHook(cfg, log, runtime);
    state.postHookUnregister = api.registerHook('PostToolUse', cfg.postToolUseMatcher, postHook);

    // --- secret_scanner_status tool ---
    api.tools.register({
      name: 'secret_scanner_status',
      description:
        'Reports the current secret-scanner state: pattern count, last block (if any), and per-mode invocation counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      mutating: false,
      async execute() {
        activateRuntime(runtime);
        return {
          ok: true,
          enabled: cfg.enabled,
          mode: cfg.mode,
          matcher: cfg.matcher,
          postToolUseMatcher: cfg.postToolUseMatcher,
          patternCount: scannerPatterns.patterns.length,
          patternTypes: scannerPatterns.patterns.map((p) => p.type),
          counters: {
            block: state.blockCount,
            redact: state.redactCount,
            allow: state.allowCount,
            leak: state.leakCount,
            timeoutCount: state.timeoutCount,
          },
          lastBlock: state.lastBlock,
          lastLeak: state.lastLeak,
        };
      },
    });

    // --- secret_scanner_test tool ---
    api.tools.register({
      name: 'secret_scanner_test',
      description:
        'Run the scanner against a user-supplied string and report which patterns matched. Useful for verifying config and tuning the matcher.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to scan for credential patterns' },
        },
        required: ['text'],
      },
      permission: 'auto',
      mutating: false,
      async execute(input: Record<string, unknown>) {
        activateRuntime(runtime);
        const rawText =
          input['text'] ??
          input['content'] ??
          input['string'] ??
          input['input'] ??
          input['code'] ??
          input['value'];
        // A missing/non-string text used to scan '' and report a clean result.
        if (typeof rawText !== 'string') {
          throw new ToolValidationError({
            message: 'text is required and must be a string',
            field: 'text',
          });
        }
        const matched = findMatches(rawText);
        return {
          ok: true,
          matched,
          count: matched.length,
        };
      },
    });

    api.log.info('secret-scanner plugin loaded', {
      version: '0.1.0',
      mode: cfg.mode,
      matcher: cfg.matcher,
      patterns: scannerPatterns.patterns.length,
    });
  },

  teardown(api) {
    const runtime = runtimes.get(api);
    if (!runtime) return;
    const { state } = runtime;
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // unregister may throw if the hook registry was already torn down;
        // teardown is best-effort.
      }
      state.hookUnregister = null;
    }
    if (state.postHookUnregister) {
      try {
        state.postHookUnregister();
      } catch {
        // same defensive catch
      }
      state.postHookUnregister = null;
    }
    const finalCounters = {
      block: state.blockCount,
      redact: state.redactCount,
      allow: state.allowCount,
      leak: state.leakCount,
    };
    state.blockCount = 0;
    state.redactCount = 0;
    state.allowCount = 0;
    state.leakCount = 0;
    state.lastBlock = null;
    state.lastLeak = null;
    runtimes.delete(api);
    api.log.info('secret-scanner: teardown complete', { counters: finalCounters });
  },

  async health() {
    const state = latestRuntime?.state ?? createState();
    // /diag plugins wants a yes/no plus context. The hook is "ok" as
    // long as the plugin is loaded; surface counters + last block/leak
    // so an operator can confirm the scanner is live.
    return {
      ok: true,
      message:
        state.lastLeak !== null
          ? `secret-scanner: last leak at ${state.lastLeak.when} on ${state.lastLeak.toolName} (${state.lastLeak.matchedTypes.join(', ')})`
          : state.lastBlock !== null
            ? `secret-scanner: last block at ${state.lastBlock.when} on ${state.lastBlock.toolName} (${state.lastBlock.matchedTypes.join(', ')})`
            : `secret-scanner: ${state.blockCount + state.redactCount + state.allowCount + state.leakCount} invocations, no blocks or leaks`,
      counters: {
        block: state.blockCount,
        redact: state.redactCount,
        allow: state.allowCount,
        leak: state.leakCount,
      },
      lastBlock: state.lastBlock,
      lastLeak: state.lastLeak,
    };
  },
};

export default plugin;
