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
 * - PreToolUse with matcher `bash|write|edit` (configurable). Default
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
import type { Plugin, PluginAPI } from '@wrongstack/core/types';
import { cloneCredentialPatterns } from '../runtime/credential-patterns.js';
import { releaseHandle } from '../runtime/index.js';

// ---------------------------------------------------------------------------
// Pattern set
// ---------------------------------------------------------------------------
//
// Mirrors the simple patterns in `core/src/security/secret-scrubber.ts`,
// minus the high-entropy-env detector (which is too slow + too
// false-positive prone for a synchronous pre-tool gate). Adding a new
// pattern here is cheap: each entry is a tuple of (id, regex). The
// combined regex folds every pattern into one pass, with the matched
// group's position used to index into the id list.

interface Pattern {
  type: string;
  regex: RegExp;
}

/**
 * Base patterns — always present, never removed by custom config.
 * Custom patterns from config are APPENDED at setup() time.
 *
 * The table itself lives in `runtime/credential-patterns` so that
 * `prompt-firewall` (which inspects outgoing provider requests) matches
 * exactly the same credential shapes. The two lists used to be maintained
 * separately and had drifted, so whether a credential was caught depended
 * on which side of the pipeline it crossed.
 */
const BASE_PATTERNS: Pattern[] = cloneCredentialPatterns();

/**
 * Active pattern set. Starts as a clone of BASE_PATTERNS; setup()
 * appends user-supplied custom patterns from config and rebuilds
 * COMBINED_REGEX. Each live PluginAPI captures its own projection.
 *
 * @internal
 */
let PATTERNS: Pattern[] = [...BASE_PATTERNS];

/**
 * Which capture-group index belongs to which pattern.
 *
 * `PATTERNS[i]` does NOT necessarily own group `i + 1`: a pattern whose
 * own source contains a capturing group consumes extra slots and shifts
 * every pattern after it. That is not hypothetical — user-supplied
 * `customPatterns` are appended verbatim, so a single custom pattern
 * spelled `(foo|bar)_[0-9]{10}` silently mis-attributed every later
 * pattern's matches (wrong `[REDACTED:<type>]` label, wrong reported
 * type). This table is rebuilt alongside the regex and consulted instead
 * of assuming a 1:1 mapping.
 *
 * @internal
 */
let GROUP_INDEX_OF_PATTERN: number[] = [];

/**
 * Combined single-pass regex. Each alternative is a capturing group so
 * the matcher callback can identify which pattern fired (only one group
 * is non-undefined at match time). Rebuilt whenever PATTERNS changes.
 *
 * @internal
 */
let COMBINED_REGEX = buildCombinedRegex(PATTERNS);

// ---------------------------------------------------------------------------
// ReDoS protection
// ---------------------------------------------------------------------------

/**
 * Size of one scan window.
 *
 * Long inputs are scanned in windows of this size rather than handed to
 * the regex engine whole — a single `exec()` over a multi-megabyte string
 * is where catastrophic backtracking would actually hurt.
 *
 * This used to be a hard skip: any input longer than 100 KB was not
 * scanned at all. That turned the size of a write into a bypass — paste a
 * credential into a large file and the gate waved it through, which is
 * precisely the case a pre-tool secret gate exists to catch. Windowing
 * keeps the ReDoS ceiling (no single huge `exec`) without the bypass.
 */
const SCAN_WINDOW_LENGTH = 100_000;

/**
 * Overlap between consecutive windows. A credential straddling a window
 * boundary would otherwise be split in half and matched by neither side.
 * This covers bounded token formats; unusually long multi-line credentials
 * that exceed the overlap remain subject to the documented windowing limit.
 */
const SCAN_WINDOW_OVERLAP = 4_096;

/**
 * Hard ceiling on total characters scanned per string leaf. Beyond this the input is
 * reported as unscannable by the caller rather than silently passed —
 * see `TOO_LARGE_MARKER`.
 */
const MAX_TOTAL_SCAN_LENGTH = 8 * 1024 * 1024;

/**
 * Pseudo-match type reported when an input exceeds `MAX_TOTAL_SCAN_LENGTH`.
 * Callers surface it instead of treating the input as clean: "we could not
 * check this" must never render as "this is fine".
 */
const TOO_LARGE_MARKER = 'unscannable_oversized_input';

/**
 * Cumulative regex execution timeout in ms. If the combined regex's
 * `while (exec(...))` loop runs longer than this, the scan throws a
 * ReDoS error. Because the hook's policy is `failurePolicy: 'closed'`,
 * the throw is caught by the hook runner and treated as a block.
 *
 * This guard catches the case where a moderate-length input triggers
 * many pattern matches (e.g. a concatenated list of tokens), causing
 * cumulative time to grow. A single long-running exec() call is
 * protected by the length guard above.
 */
const RE_DOS_TIMEOUT_MS = 100;

/**
 * Rebuild the combined regex from a pattern array. Each pattern's
 * source is wrapped in a capturing group so findMatches/redactInput
 * can identify which one fired.
 *
 * Performance: only rebuilds when the pattern set has actually changed
 * (detected via patternCacheKey comparison). Avoids expensive regex
 * compilation on every setup() reload when patterns are unchanged.
 *
 * @internal
 */
/**
 * Count the capturing groups in a regex source. Appending `|` makes the
 * whole pattern optional, so `exec('')` always matches and its result
 * length reveals the group count without needing to parse the source.
 */
function countCaptureGroups(source: string): number {
  try {
    return new RegExp(`${source}|`).exec('')!.length - 1;
  } catch {
    return 0;
  }
}

/**
 * Map a match's capture groups back to the pattern that fired.
 * `groups` is 0-indexed from the first capture group (i.e. `m[1]`).
 */
function patternTypeForGroups(groups: readonly unknown[]): string | undefined {
  for (let i = 0; i < PATTERNS.length; i++) {
    const at = GROUP_INDEX_OF_PATTERN[i];
    if (at !== undefined && groups[at] !== undefined) return PATTERNS[i]!.type;
  }
  return undefined;
}

function buildCombinedRegex(patterns: Pattern[]): RegExp {
  // Record each pattern's outer-group offset before its own inner groups.
  const offsets: number[] = [];
  let cursor = 0;
  for (const p of patterns) {
    offsets.push(cursor);
    cursor += 1 + countCaptureGroups(p.regex.source);
  }
  GROUP_INDEX_OF_PATTERN = offsets;
  return new RegExp(patterns.map((p) => `(${p.regex.source})`).join('|'), 'g');
}

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
  PATTERNS = runtime.patterns;
  COMBINED_REGEX = runtime.combinedRegex;
  GROUP_INDEX_OF_PATTERN = runtime.groupIndexes;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find every pattern that fires on `text`. Returns the list of matched
 * `type` ids (deduped). The combined regex is one pass; the capture
 * group index maps back to the pattern via the parallel PATTERNS array.
 *
 * Determinism: returns matched types in sorted order so scan results
 * are reproducible across runs.
 */
/** Scan one window with the combined regex, accumulating matched types. */
function scanWindow(window: string, found: Set<string>, startTime: number): void {
  COMBINED_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic RegExp.exec loop
  while ((m = COMBINED_REGEX.exec(window)) !== null) {
    // ReDoS guard: abort if cumulative regex time exceeds the threshold.
    // The throw propagates through buildHook synchronously; with
    // failurePolicy: 'closed' it is caught and treated as a block.
    if (performance.now() - startTime > RE_DOS_TIMEOUT_MS) {
      throw new Error(
        `secret-scanner: ReDoS timeout — regex scan exceeded ${RE_DOS_TIMEOUT_MS}ms on ${window.length}-char window`,
      );
    }
    // Determine which pattern fired. Group offsets come from the table
    // built with the regex — a pattern containing its own capture groups
    // shifts every later pattern, so `m[i + 1]` is not reliable.
    const type = patternTypeForGroups(m.slice(1));
    if (type !== undefined) found.add(type);
    // Defensive: avoid infinite loop on zero-width matches (none of the
    // current patterns are zero-width, but future additions might be).
    if (m.index === COMBINED_REGEX.lastIndex) {
      COMBINED_REGEX.lastIndex += 1;
    }
  }
}

function findMatches(text: string): string[] {
  if (!text) return [];
  const found = new Set<string>();
  const startTime = performance.now();

  if (text.length <= SCAN_WINDOW_LENGTH) {
    scanWindow(text, found, startTime);
    return Array.from(found).sort();
  }

  // Oversized input: report it rather than pass it. Silently returning "no
  // matches" for something we declined to read is indistinguishable from
  // "clean", and that is the wrong default for a security gate.
  if (text.length > MAX_TOTAL_SCAN_LENGTH) {
    return [TOO_LARGE_MARKER];
  }

  // Long input: scan in overlapping windows. Keeps every individual
  // `exec()` bounded (the actual ReDoS risk) while still inspecting the
  // whole input — previously anything past 100 KB was skipped outright,
  // so file size alone was enough to walk a credential past the gate.
  const stride = SCAN_WINDOW_LENGTH - SCAN_WINDOW_OVERLAP;
  for (let offset = 0; offset < text.length; offset += stride) {
    scanWindow(text.slice(offset, offset + SCAN_WINDOW_LENGTH), found, startTime);
  }
  return Array.from(found).sort();
}

/**
 * Walk an arbitrary input value, return the first set of matched types
 * found in any string-typed leaf. Returns `null` if nothing matched
 * anywhere — saves the caller from scanning more fields once a hit is
 * confirmed.
 */
function scanInput(input: unknown, depth = 0): string[] | null {
  if (input === null || input === undefined) return null;
  // ReDoS guard: limit recursion depth to prevent stack overflow on
  // deeply nested objects crafted to bypass the string-length check.
  if (depth > 50) return null;
  if (typeof input === 'string') {
    const found = findMatches(input);
    return found.length > 0 ? found : null;
  }
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = scanInput(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof input === 'object') {
    for (const value of Object.values(input as Record<string, unknown>)) {
      const found = scanInput(value, depth + 1);
      if (found) return found;
    }
    return null;
  }
  // Numbers, booleans, bigints — credentials are strings, no point scanning.
  return null;
}

/** A redaction either produces a complete safe clone or fails closed. */
type RedactionResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'oversized_input' | 'maximum_depth_exceeded' };

/** Redact one bounded string without using an unguarded global replace. */
function redactString(text: string): RedactionResult {
  // Windowed scanning can safely detect a match across large input, but
  // reconstructing overlapping redaction windows without duplicate or partial
  // replacements is a different operation. Fail closed instead of running the
  // combined regex over a multi-window string in one unbounded replace pass.
  if (text.length > SCAN_WINDOW_LENGTH) {
    return { ok: false, reason: 'oversized_input' };
  }

  const startTime = performance.now();
  let cursor = 0;
  let output = '';
  COMBINED_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic RegExp.exec loop
  while ((match = COMBINED_REGEX.exec(text)) !== null) {
    if (performance.now() - startTime > RE_DOS_TIMEOUT_MS) {
      return { ok: false, reason: 'oversized_input' };
    }
    const type = patternTypeForGroups(match.slice(1));
    output += text.slice(cursor, match.index);
    output += `[REDACTED:${type ?? 'unknown'}]`;
    cursor = COMBINED_REGEX.lastIndex;
    if (match.index === COMBINED_REGEX.lastIndex) {
      COMBINED_REGEX.lastIndex += 1;
    }
  }
  if (cursor === 0) return { ok: true, value: text };
  return { ok: true, value: output + text.slice(cursor) };
}

/**
 * Walk an arbitrary input value, returning a deep clone with every
 * string-typed leaf redacted. Only used in `mode: 'redact'`.
 *
 * Every string leaf is independently redacted through the bounded exec loop.
 * This is intentional even though buildHook already found one match:
 * scanInput stops at the first match, while redaction must prove that every
 * sibling is within the redactor's size/time bounds. If any leaf cannot be
 * processed, no partially-redacted input is returned.
 */
function redactInput(input: unknown, depth = 0): RedactionResult {
  if (input === null || input === undefined) return { ok: true, value: input };
  // Unlike scan-only mode, returning the original subtree here would allow
  // uninspected content through a hook that claims to have redacted it.
  if (depth > 50) return { ok: false, reason: 'maximum_depth_exceeded' };
  if (typeof input === 'string') {
    return redactString(input);
  }
  if (Array.isArray(input)) {
    const out: unknown[] = [];
    for (const item of input) {
      const redacted = redactInput(item, depth + 1);
      if (!redacted.ok) return redacted;
      out.push(redacted.value);
    }
    return { ok: true, value: out };
  }
  if (typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      const redacted = redactInput(v, depth + 1);
      if (!redacted.ok) return redacted;
      out[k] = redacted.value;
    }
    return { ok: true, value: out };
  }
  return { ok: true, value: input };
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
  matcher: 'bash|write|edit',
  postToolUseMatcher: '*',
  mode: 'block',
  enabled: true,
  customPatterns: [],
};

function readConfig(raw: unknown): SecretScannerConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const rawMode = typeof (r['mode'] ?? r['action'] ?? r['behavior']) === 'string'
    ? String(r['mode'] ?? r['action'] ?? r['behavior']).trim().toLowerCase()
    : undefined;
  const mode: Mode = rawMode === 'redact' || rawMode === 'allow' || rawMode === 'warn'
    ? (rawMode === 'warn' ? 'allow' : rawMode as Mode)
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
      typeof (r['postToolUseMatcher'] ?? r['post_tool_use_matcher'] ?? r['outputMatcher']) === 'string'
        ? (r['postToolUseMatcher'] ?? r['post_tool_use_matcher'] ?? r['outputMatcher']) as string
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
        return {
          decision: 'block',
          reason:
            'secret-scanner: ReDoS timeout — regex scan exceeded the wall-clock budget. Fail-closed: treated as a block.',
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
    PATTERNS = [...BASE_PATTERNS];
    for (const cp of cfg.customPatterns) {
      try {
        PATTERNS.push({ type: cp.type, regex: new RegExp(cp.regex, 'g') });
      } catch {
        // readConfig already validated; this catch is defensive.
      }
    }
    COMBINED_REGEX = buildCombinedRegex(PATTERNS);
    const runtime: SecretScannerRuntime = {
      state: createState(),
      patterns: PATTERNS,
      combinedRegex: COMBINED_REGEX,
      groupIndexes: [...GROUP_INDEX_OF_PATTERN],
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
          patternCount: PATTERNS.length,
          patternTypes: PATTERNS.map((p) => p.type),
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
          input['value'] ??
          '';
        const text = typeof rawText === 'string' ? rawText : '';
        const matched = findMatches(text);
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
      patterns: PATTERNS.length,
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
