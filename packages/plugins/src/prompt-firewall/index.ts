import {
  collectText,
  countMatches,
  createScanDeadline,
  type Detection,
  detectSecretsGuarded,
  PATTERNS,
  redactDeep,
  type ScanBudget,
} from './secret-detection.js';

export {
  type Detection,
  detectSecretsGuarded,
  KIND_ALIASES,
  redactSecrets,
  redactSecretsGuarded,
  SCAN_WINDOW_LIMIT,
  type ScanSkip,
} from './secret-detection.js';

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
 * Safety posture: opt-in at host plugin loading; once loaded, the internal
 * enabled switch defaults to true. `redact` is the
 * default so secrets are automatically stripped; switch to `warn` only
 * for detection-mode diagnostics without data loss.
 *
 * Config (`config.extensions['prompt-firewall']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
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
import type { Plugin, PluginAPI } from '@wrongstack/contracts/types';
import { createHostStates, providerSignal } from '../runtime/host-state.js';

/** Detect secret matches in text. Returns per-kind counts (no values). */
export function detectSecrets(text: string, allow: RegExp[]): Detection[] {
  const counts = new Map<string, number>();
  for (const p of PATTERNS) countMatches(p, text, allow, counts);
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
}

/**
 * Hard ceiling on total characters redacted in one response-side walk
 * (issue #362 residual). Provider responses with function-calling traces
 * can be megabytes; past this budget the walk stops and the truncation is
 * surfaced (status + log + counter) instead of stalling the provider loop.
 */
const RESPONSE_SCAN_BUDGET = 1_000_000;

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
    // Opt-in belongs to host enablement, not this switch — see the
    // plugin-enable-double-gate audit. `redact` remains the default mode, so
    // enabling the plugin strips secrets rather than refusing requests.
    enabled: true,
    mode: 'redact',
    scanResponse: true,
    allow: [],
  };
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;
  const rawAllow = r['allow'] ?? r['allowlist'] ?? r['allowed'];
  const allow: RegExp[] = Array.isArray(rawAllow)
    ? (rawAllow as unknown[])
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .flatMap((s) => {
          try {
            return [new RegExp(s)];
          } catch {
            return [];
          }
        })
    : [];
  const rawMode =
    typeof (r['mode'] ?? r['action'] ?? r['behavior']) === 'string'
      ? String(r['mode'] ?? r['action'] ?? r['behavior'])
          .trim()
          .toLowerCase()
      : undefined;
  const mode = rawMode === 'warn' ? 'warn' : rawMode === 'block' ? 'block' : 'redact';
  const rawScan = r['scanResponse'] ?? r['scan_response'];
  return {
    enabled: r['enabled'] !== false,
    mode,
    scanResponse: rawScan !== false,
    allow,
  };
}

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface PromptFirewallState {
  abort: AbortController;
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

function createState(): PromptFirewallState {
  return {
    abort: new AbortController(),
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
}
const hosts = createHostStates(createState);

/**
 * Surface kinds that crossed the cumulative scan-pass budget mid-pass
 * (issue #370): merge into the visible skip surface with the same
 * counter/log treatment as probe timeouts. One call per tripped walk.
 */
function surfaceScanTrips(
  state: PromptFirewallState,
  api: PluginAPI,
  tripped: ReadonlySet<string>,
): void {
  for (const kind of tripped) {
    if (!state.skippedPatterns.includes(kind)) state.skippedPatterns.push(kind);
  }
  state.timeoutCount += 1;
  api.metrics.counter('redos_skips', 1);
  api.log.warn(
    'prompt-firewall: scan-pass budget exceeded — patterns skipped mid-pass (issue #370)',
    {
      skipped: [...tripped],
    },
  );
}

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
  defaultConfig: { enabled: true, mode: 'redact', scanResponse: true, allow: [] },
  configSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        default: true,
        description:
          'Master switch after the plugin is loaded. Plugin loading is controlled separately.',
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
    const state = hosts.reset(api);
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
          const signal = providerSignal(state, _ctx);
          signal.throwIfAborted();
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
          signal.throwIfAborted();
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
              const deadline = createScanDeadline();
              const redactedReq = redactDeep(
                req,
                cfg.allow,
                counter,
                skipSet,
                undefined,
                deadline,
              ) as Record<string, unknown>;
              state.requestRedactions += counter.n;
              api.metrics.counter('request_redactions', counter.n);
              if (deadline.tripped.size > 0) surfaceScanTrips(state, api, deadline.tripped);
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
    function redactResponse(
      response: unknown,
      allow: RegExp[],
      skip?: ReadonlySet<string>,
    ): unknown {
      if (!response || typeof response !== 'object') return response;
      const counter = { n: 0 };
      const budget: ScanBudget = { remaining: RESPONSE_SCAN_BUDGET, truncated: false };
      const deadline = createScanDeadline();
      const redacted = redactDeep(response, allow, counter, skip, budget, deadline);
      if (deadline.tripped.size > 0) surfaceScanTrips(state, api, deadline.tripped);
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
      return redacted;
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
    const state = hosts.remove(api);
    if (!state) return;
    const final = {
      invocations: state.invocations,
      requestsWithSecrets: state.requestsWithSecrets,
      requestRedactions: state.requestRedactions,
      responseRedactions: state.responseRedactions,
      blocked: state.blocked,
      timeoutCount: state.timeoutCount,
    };
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
    api.log.info('prompt-firewall: teardown complete', { final });
  },

  async health() {
    const state = createState();
    for (const active of hosts.values()) {
      state.invocations += active.invocations;
      state.requestsWithSecrets += active.requestsWithSecrets;
      state.requestRedactions += active.requestRedactions;
      state.responseRedactions += active.responseRedactions;
      state.blocked += active.blocked;
      state.timeoutCount += active.timeoutCount;
    }
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
