/**
 * prompt-firewall plugin — inspects and redacts secrets on the provider
 * wire, before context leaves for the LLM API and as it returns.
 *
 * Distinct from `secret-scanner` (which guards the TOOL boundary): this
 * sits on `AgentExtension.wrapProviderRunner`, so it sees the FULL
 * request that is about to be sent to a third-party LLM provider —
 * regardless of how a secret entered the conversation. It scans the
 * outgoing request's system + message text for high-confidence
 * credential patterns and, depending on `mode`:
 *
 *  - `warn`   — logs + counts + emits a `prompt-firewall:leak`
 *    event; the request goes through unchanged
 *  - `redact` (default) — replaces each match with `[REDACTED:<kind>]` in a CLONE
 *    of the request before sending, and also redacts secrets echoed back
 *    in the response
 *  - `block`  — throws before the request is sent (the agent's error
 *    path surfaces it), so the secret never reaches the provider
 *
 * Safety posture: opt-in — loads inert until
 * `config.extensions['prompt-firewall'].enabled = true`. `redact` is the
 * default so secrets are automatically stripped; switch to `warn` only
 * for detection-mode diagnostics without data loss.
 *
 * Config (`config.extensions['prompt-firewall']`):
 *
 * ```jsonc
 * {
 *   "enabled": false,
 *   "mode": "redact",        // "warn" | "redact" | "block"
 *   "scanResponse": true,     // redact secrets echoed back (redact mode)
 *   "allow": []               // regex source strings to exempt (false positives)
 * }
 * ```
 *
 * Tools:
 *  - `prompt_firewall_status` — mode, pattern names, detection counters
 *
 * @public
 */
import type { Plugin, PluginAPI } from '@wrongstack/core/types';
import { cloneCredentialPatterns } from '../runtime/credential-patterns.js';
import { withReDoSGuard } from '../runtime/redos-guard.js';

// ---------------------------------------------------------------------------
// Secret patterns — high-confidence only, to keep false positives low.
// ---------------------------------------------------------------------------

interface SecretPattern {
  kind: string;
  re: RegExp;
}

/**
 * Legacy `kind` names for the shapes this plugin already reported, so the
 * canonical `type` ids from the shared table keep their existing spelling
 * in logs, metrics and the status tool. Anything not listed here is
 * reported under its canonical id.
 */
export const KIND_ALIASES: Readonly<Record<string, string>> = {
  aws_access_key: 'aws-access-key',
  private_key: 'private-key-block',
  github_pat: 'github-token',
  github_oauth_token: 'github-token',
  openai_key: 'openai-key',
  anthropic_key: 'anthropic-key',
  slack_token: 'slack-token',
  gcp_key: 'google-api-key',
  bearer_token: 'bearer-token',
};

/**
 * Patterns unique to this surface.
 *
 * The shared table covers credentials with a distinctive prefix. These
 * two are shape-and-context heuristics that only make sense for an
 * outgoing request (where a false positive costs a redaction, not a
 * blocked write), so they stay local.
 */
const EXTRA_PATTERNS: SecretPattern[] = [
  {
    // AWS secret access keys have no prefix — only a 40-char base64-ish
    // shape — so they need a nearby `aws`/`secret` mention to be worth
    // acting on.
    //
    // The previous spelling required the word "aws" to appear AFTER the
    // key and wrapped the run in `\b`. Both are wrong: the real layout is
    // `AWS_SECRET_ACCESS_KEY=<key>` (context first), and a `\b` cannot
    // hold next to the `+` or `/` that base64 keys routinely end with. The
    // pattern therefore never fired on a real key. Anchor on the context
    // token instead and let the key follow it.
    kind: 'aws-secret-key',
    re: /(?:aws|amazon)[A-Za-z0-9_-]*(?:secret|key)[A-Za-z0-9_-]*\s*[:=]\s*['"]?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+])/gi,
  },
  {
    kind: 'generic-secret-assignment',
    re: /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"]?[A-Za-z0-9._/+-]{12,}['"]?/gi,
  },
];

/**
 * Effective pattern set: every shape the canonical table knows about,
 * plus this plugin's own heuristics.
 *
 * Sharing the table with `secret-scanner` is the point — the two lists
 * had drifted, so whether a credential was caught depended on which side
 * of the pipeline it crossed.
 */
const PATTERNS: SecretPattern[] = [
  ...cloneCredentialPatterns().map((p) => ({
    kind: KIND_ALIASES[p.type] ?? p.type,
    re: p.regex,
  })),
  ...EXTRA_PATTERNS,
];

export interface Detection {
  kind: string;
  count: number;
}

/**
 * A pattern excluded from a scan pass. `redos-timeout` = the pattern blew
 * its wall-clock budget on the guarded probe and was skipped (fail-open
 * with a visible counter — this surface trades blocking for availability;
 * `secret-scanner` is the fail-closed tool-side gate).
 */
export interface ScanSkip {
  kind: string;
  reason: 'redos-timeout';
}

/**
 * Per-pattern wall-clock budget for the guarded probe pass (issue #362
 * residual). Matches secret-scanner's per-exec scale; a clean pattern
 * finishes in well under a millisecond on typical request text.
 */
const PATTERN_BUDGET_MS = 250;

/**
 * Probe window size. The probe decides "can this regex run without
 * exploding" per window; 100 KB keeps each worker round-trip bounded
 * while the windowed walk (with overlap) still covers the entire input.
 */
const GUARD_PROBE_LENGTH = 100_000;

/**
 * Overlap between probe windows so a credential-shaped (or pathological)
 * run straddling a boundary is still exercised. Matches secret-scanner's
 * window overlap.
 */
const GUARD_PROBE_OVERLAP = 4_096;

/** Shared match core: count per-kind hits in `text`. */
function countMatches(
  p: SecretPattern,
  text: string,
  allow: RegExp[],
  counts: Map<string, number>,
): void {
  p.re.lastIndex = 0;
  let m: RegExpExecArray | null = p.re.exec(text);
  while (m !== null) {
    const matched = m[0];
    if (!allow.some((a) => a.test(matched))) {
      counts.set(p.kind, (counts.get(p.kind) ?? 0) + 1);
    }
    m = p.re.exec(text);
  }
}

/** Shared redaction core: replace hits of one pattern with `[REDACTED:<kind>]`. */
function replacePattern(
  p: SecretPattern,
  text: string,
  allow: RegExp[],
  redactions: { n: number },
): string {
  return text.replace(new RegExp(p.re.source, p.re.flags), (match) => {
    if (allow.some((a) => a.test(match))) return match;
    redactions.n += 1;
    return `[REDACTED:${p.kind}]`;
  });
}

/** Detect secret matches in text. Returns per-kind counts (no values). */
export function detectSecrets(text: string, allow: RegExp[]): Detection[] {
  const counts = new Map<string, number>();
  for (const p of PATTERNS) countMatches(p, text, allow, counts);
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
}

/** Redact secret matches in text, replacing each with `[REDACTED:<kind>]`. */
export function redactSecrets(text: string, allow: RegExp[]): { text: string; redactions: number } {
  const redactions = { n: 0 };
  let out = text;
  for (const p of PATTERNS) out = replacePattern(p, out, allow, redactions);
  return { text: out, redactions: redactions.n };
}

/**
 * Guarded probe: which patterns cannot complete within `PATTERN_BUDGET_MS`.
 * The ENTIRE input is probed in overlapping windows (issue #362: probing
 * only a prefix would let late-input pathology through) — one
 * combined-alternation worker per window in the common clean case; the
 * per-pattern fallback runs only for windows where the combined regex
 * trips, to identify the offender(s) for the skip set.
 */
async function probeTimedOutPatterns(text: string): Promise<Set<string>> {
  const timedOut = new Set<string>();
  if (text.length === 0) return timedOut;

  const probeWindow = (offset: number): Promise<void> => {
    const window = text.slice(offset, offset + GUARD_PROBE_LENGTH);
    const combined = new RegExp(PATTERNS.map((p) => `(${p.re.source})`).join('|'), 'gi');
    return withReDoSGuard(combined, window, PATTERN_BUDGET_MS).then(async (combinedResult) => {
      if (!combinedResult.timedOut) return;
      for (const p of PATTERNS) {
        if (timedOut.has(p.kind)) continue;
        const result = await withReDoSGuard(p.re, window, PATTERN_BUDGET_MS);
        if (result.timedOut) timedOut.add(p.kind);
      }
    });
  };

  const stride = GUARD_PROBE_LENGTH - GUARD_PROBE_OVERLAP;
  for (let offset = 0; offset < text.length; offset += stride) {
    await probeWindow(offset);
  }
  return timedOut;
}

/**
 * Detect secret matches, skipping patterns that blow the ReDoS budget on
 * the guarded probe. The skip set is returned so callers can surface it
 * (status counters / logs) instead of silently trusting the result.
 */
export async function detectSecretsGuarded(
  text: string,
  allow: RegExp[],
): Promise<{ detections: Detection[]; skipped: ScanSkip[] }> {
  const timedOut = await probeTimedOutPatterns(text);
  const counts = new Map<string, number>();
  for (const p of PATTERNS) {
    if (!timedOut.has(p.kind)) countMatches(p, text, allow, counts);
  }
  return {
    detections: [...counts.entries()].map(([kind, count]) => ({ kind, count })),
    skipped: [...timedOut].sort().map((kind) => ({ kind, reason: 'redos-timeout' as const })),
  };
}

/**
 * Redact secret matches, skipping the given timed-out patterns (reuse the
 * set from `detectSecretsGuarded` so a request pays the probe once).
 */
export function redactSecretsGuarded(
  text: string,
  allow: RegExp[],
  skip: ReadonlySet<string>,
): { text: string; redactions: number } {
  const redactions = { n: 0 };
  let out = text;
  for (const p of PATTERNS) {
    if (!skip.has(p.kind)) out = replacePattern(p, out, allow, redactions);
  }
  return { text: out, redactions: redactions.n };
}

// ---------------------------------------------------------------------------
// Request/response text walking (redact in-place on a clone)
// ---------------------------------------------------------------------------

/** Concatenate all string text under system + messages for scanning. */
function collectText(request: Record<string, unknown>): string {
  const parts: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) for (const i of v) walk(i);
    else if (v && typeof v === 'object')
      for (const val of Object.values(v as Record<string, unknown>)) walk(val);
  };
  walk(request['system']);
  walk(request['messages']);
  return parts.join('\n');
}

/**
 * Hard ceiling on total characters redacted in one response-side walk
 * (issue #362 residual). Provider responses with function-calling traces
 * can be megabytes; past this budget the walk stops and the truncation is
 * surfaced (status + log + counter) instead of stalling the provider loop.
 */
const RESPONSE_SCAN_BUDGET = 1_000_000;

/** Mutable char budget shared across one redaction walk. */
interface ScanBudget {
  remaining: number;
  /** True only when a leaf was actually skipped for exceeding the budget. */
  truncated: boolean;
}

/** Deep-clone `value`, redacting every string leaf. Returns [clone, count]. */
function redactDeep(
  value: unknown,
  allow: RegExp[],
  counter: { n: number },
  skip?: ReadonlySet<string>,
  budget?: ScanBudget,
): unknown {
  if (typeof value === 'string') {
    if (budget) {
      // A leaf larger than the remaining budget is skipped whole — scanning
      // it would unbind the walk (chimera review finding), and slicing
      // mid-leaf could half-redact a credential. The caller surfaces the
      // truncation; the unscanned tail is returned as-is.
      if (value.length > budget.remaining) {
        budget.remaining = 0;
        budget.truncated = true;
        return value;
      }
      budget.remaining -= value.length;
    }
    const { text, redactions } = skip
      ? redactSecretsGuarded(value, allow, skip)
      : redactSecrets(value, allow);
    counter.n += redactions;
    return text;
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, allow, counter, skip, budget));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, allow, counter, skip, budget);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type FirewallMode = 'warn' | 'redact' | 'block';

interface PromptFirewallConfig {
  enabled: boolean;
  mode: FirewallMode;
  scanResponse: boolean;
  allow: RegExp[];
}

export function readConfig(raw: unknown): PromptFirewallConfig {
  const base: PromptFirewallConfig = {
    enabled: false,
    mode: 'redact',
    scanResponse: true,
    allow: [],
  };
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  const allow: RegExp[] = Array.isArray(r['allow'])
    ? r['allow']
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .flatMap((s) => {
          try {
            return [new RegExp(s)];
          } catch {
            return [];
          }
        })
    : [];
  return {
    enabled: r['enabled'] === true,
    mode: r['mode'] === 'warn' ? 'warn' : r['mode'] === 'block' ? 'block' : 'redact',
    scanResponse: r['scanResponse'] !== false,
    allow,
  };
}

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface PromptFirewallState {
  invocations: number;
  requestsWithSecrets: number;
  requestRedactions: number;
  responseRedactions: number;
  blocked: number;
  timeoutCount: number;
  /** Patterns skipped on the last request scan because they blew the ReDoS budget (issue #362). */
  skippedPatterns: string[];
  /** True once a response-side walk has ever exhausted RESPONSE_SCAN_BUDGET (issue #362). */
  responseTruncated: boolean;
  byKind: Map<string, number>;
  lastDetection: { where: string; kinds: string[]; when: string } | null;
  extensionUnregister: null | (() => void);
}

const state: PromptFirewallState = {
  invocations: 0,
  requestsWithSecrets: 0,
  requestRedactions: 0,
  responseRedactions: 0,
  blocked: 0,
  timeoutCount: 0,
  skippedPatterns: [],
  responseTruncated: false,
  byKind: new Map(),
  lastDetection: null,
  extensionUnregister: null,
};

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'prompt-firewall',
  version: '0.1.0',
  description:
    'Scans the provider wire for credential leaks before context reaches the LLM API (wrapProviderRunner); redact/warn/block. Opt-in; redact by default.',
  apiVersion: '^0.1.10',
  capabilities: { tools: true },
  // Wrap-stack contract (issue #362): ExtensionRegistry composes wrappers
  // first-registered = outermost. The manifest lists this plugin before
  // llm-cache, and llm-cache declares this plugin in optionalDeps, so the
  // firewall is the outer wrap: every request is scanned/redacted before
  // llm-cache can fingerprint or cache it.
  defaultConfig: { enabled: false, mode: 'redact', scanResponse: true, allow: [] },
  configSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        default: false,
        description:
          'Master switch. OFF by default; redact/block modes can alter or stop provider calls.',
      },
      mode: {
        type: 'string',
        enum: ['warn', 'redact', 'block'],
        default: 'redact',
        description:
          'redact (default) = strip secrets from the request/response; warn = detect only; block = refuse the request.',
      },
      scanResponse: {
        type: 'boolean',
        default: true,
        description: 'In redact mode, also redact secrets echoed back in the provider response.',
      },
      allow: {
        type: 'array',
        items: { type: 'string' },
        default: [],
        description:
          'Regex source strings whose matches are exempt (to silence known false positives).',
      },
    },
  },

  setup(api: PluginAPI) {
    // Idempotent re-init (H1 pattern).
    state.invocations = 0;
    state.requestsWithSecrets = 0;
    state.requestRedactions = 0;
    state.responseRedactions = 0;
    state.blocked = 0;
    state.timeoutCount = 0;
    state.skippedPatterns = [];
    state.responseTruncated = false;
    state.byKind.clear();
    state.lastDetection = null;
    if (state.extensionUnregister) {
      try {
        state.extensionUnregister();
      } catch {
        // best-effort
      }
      state.extensionUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['prompt-firewall']);

    if (cfg.enabled) {
      // Announce participation in the wrap stack so plugin-stack-observer
      // can build a system-prompt summary of who is wrapping what.
      api.emitCustom?.('provider.wrap:loaded', {
        plugin: 'prompt-firewall',
        kind: 'security',
        wraps: ['request', 'response'],
      });
      state.extensionUnregister = api.extensions.register({
        name: 'prompt-firewall',
        owner: 'prompt-firewall',
        async wrapProviderRunner(
          _ctx: unknown,
          request: unknown,
          inner: (c: unknown, r: unknown) => Promise<unknown>,
        ) {
          const req = (request ?? {}) as Record<string, unknown>;
          state.invocations += 1;

          // Wrap-stack contract (issue #362): the manifest lists this plugin
          // before llm-cache and llm-cache declares this plugin in
          // optionalDeps, so ExtensionRegistry (first-registered = outermost)
          // makes the firewall the OUTER wrap. Every request is
          // scanned/redacted first; llm-cache only sees — and only caches —
          // already-redacted requests, so a cache hit cannot replay a
          // pre-firewall credential.
          const requestText = collectText(req);

          // Guarded detection (issue #362 residual): patterns that blow the
          // ReDoS budget are skipped, counted, and logged — the guarded
          // result now GATES the detection/redaction pass instead of being
          // discarded.
          const { detections, skipped } = await detectSecretsGuarded(requestText, cfg.allow);
          // Always refresh from THIS request's result — a stale skip set
          // from a previous timed-out request would silently skip patterns
          // forever (chimera review finding).
          state.skippedPatterns = skipped.map((s) => s.kind);
          if (skipped.length > 0) {
            state.timeoutCount += 1;
            api.log.warn('prompt-firewall: ReDoS budget exceeded, patterns skipped', {
              skipped: state.skippedPatterns,
            });
            api.metrics.counter('redos_skips', 1);
          }
          const skipSet = new Set(state.skippedPatterns);
          if (detections.length > 0) {
            state.requestsWithSecrets += 1;
            for (const d of detections) {
              state.byKind.set(d.kind, (state.byKind.get(d.kind) ?? 0) + d.count);
            }
            const kinds = detections.map((d) => d.kind);
            state.lastDetection = { where: 'request', kinds, when: new Date().toISOString() };
            api.metrics.counter('request_leaks', 1);
            api.log.warn('prompt-firewall: secrets detected in outgoing request', { kinds });
            api.emitCustom('prompt-firewall:leak', { where: 'request', kinds });

            if (cfg.mode === 'block') {
              state.blocked += 1;
              throw new Error(
                `prompt-firewall blocked a provider call: outgoing context contains credential-shaped data (${kinds.join(', ')}). ` +
                  'Remove the secret from context, add an `allow` pattern, or switch mode to "warn".',
              );
            }
            if (cfg.mode === 'redact') {
              const counter = { n: 0 };
              const redactedReq = redactDeep(req, cfg.allow, counter, skipSet) as Record<string, unknown>;
              state.requestRedactions += counter.n;
              api.metrics.counter('request_redactions', counter.n);
              const response = await inner(_ctx, redactedReq);
              return cfg.scanResponse ? redactResponse(response, cfg.allow, skipSet) : response;
            }
          }

          const response = await inner(_ctx, request);
          if (cfg.mode === 'redact' && cfg.scanResponse) {
            return redactResponse(response, cfg.allow, skipSet);
          }
          return response;
        },
      } as never);
    }

    // Redact secrets echoed back in the provider response's content.
    // Bounded by RESPONSE_SCAN_BUDGET (issue #362 residual) so a huge
    // function-calling trace cannot unbind the walk, and by the request-side
    // skip set so a pattern that blew its ReDoS budget is never run
    // unguarded on response text either (chimera review finding).
    function redactResponse(response: unknown, allow: RegExp[], skip?: ReadonlySet<string>): unknown {
      if (!response || typeof response !== 'object') return response;
      const counter = { n: 0 };
      const content = (response as { content?: unknown }).content;
      if (content === undefined) return response;
      const budget: ScanBudget = { remaining: RESPONSE_SCAN_BUDGET, truncated: false };
      const redacted = redactDeep(content, allow, counter, skip, budget);
      // Only a real skip (budget.truncated) latches the flag — an exact-fit
      // walk that legitimately drives `remaining` to 0 is not truncation.
      if (budget.truncated) {
        state.responseTruncated = true;
        api.log.warn(
          'prompt-firewall: response scan budget exhausted — part of the response was returned unredacted',
        );
        api.metrics.counter('response_scan_truncated', 1);
      }
      if (counter.n > 0) {
        state.responseRedactions += counter.n;
        api.metrics.counter('response_redactions', counter.n);
        state.lastDetection = {
          where: 'response',
          kinds: ['echoed-secret'],
          when: new Date().toISOString(),
        };
      }
      return { ...(response as Record<string, unknown>), content: redacted };
    }

    api.tools.register({
      name: 'prompt_firewall_status',
      description:
        'Reports prompt-firewall state: mode, pattern kinds, and detection/redaction/block counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          mode: cfg.mode,
          scanResponse: cfg.scanResponse,
          patterns: PATTERNS.map((p) => p.kind),
          skippedPatterns: state.skippedPatterns,
          responseTruncated: state.responseTruncated,
          counters: {
            invocations: state.invocations,
            requestsWithSecrets: state.requestsWithSecrets,
            requestRedactions: state.requestRedactions,
            responseRedactions: state.responseRedactions,
            blocked: state.blocked,
            timeoutCount: state.timeoutCount,
          },
          byKind: Object.fromEntries(state.byKind),
          lastDetection: state.lastDetection,
        };
      },
    });

    api.log.info('prompt-firewall plugin loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      mode: cfg.mode,
      patterns: PATTERNS.length,
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
      requestsWithSecrets: state.requestsWithSecrets,
      requestRedactions: state.requestRedactions,
      responseRedactions: state.responseRedactions,
      blocked: state.blocked,
    };
    state.invocations = 0;
    state.requestsWithSecrets = 0;
    state.requestRedactions = 0;
    state.responseRedactions = 0;
    state.blocked = 0;
    state.byKind.clear();
    state.lastDetection = null;
    api.log.info('prompt-firewall: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message: `prompt-firewall: ${state.requestsWithSecrets} request(s) with secrets, ${state.requestRedactions} request redaction(s), ${state.blocked} blocked`,
      counters: {
        invocations: state.invocations,
        requestsWithSecrets: state.requestsWithSecrets,
        requestRedactions: state.requestRedactions,
        responseRedactions: state.responseRedactions,
        blocked: state.blocked,
      },
    };
  },
};

export default plugin;
