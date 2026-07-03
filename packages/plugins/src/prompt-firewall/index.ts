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
 *  - `warn`   (default) — logs + counts + emits a `prompt-firewall:leak`
 *    event; the request goes through unchanged
 *  - `redact` — replaces each match with `[REDACTED:<kind>]` in a CLONE
 *    of the request before sending, and also redacts secrets echoed back
 *    in the response
 *  - `block`  — throws before the request is sent (the agent's error
 *    path surfaces it), so the secret never reaches the provider
 *
 * Safety posture: opt-in — loads inert until
 * `config.extensions['prompt-firewall'].enabled = true`. `warn` is the
 * default so it can never corrupt context until you deliberately choose
 * `redact`/`block`.
 *
 * Config (`config.extensions['prompt-firewall']`):
 *
 * ```jsonc
 * {
 *   "enabled": false,
 *   "mode": "warn",          // "warn" | "redact" | "block"
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
import type { Plugin, PluginAPI } from '@wrongstack/core';

// ---------------------------------------------------------------------------
// Secret patterns — high-confidence only, to keep false positives low.
// ---------------------------------------------------------------------------

interface SecretPattern {
  kind: string;
  re: RegExp;
}

const PATTERNS: SecretPattern[] = [
  { kind: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    kind: 'aws-secret-key',
    re: /\b(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])\b(?=.*aws)/gi,
  },
  { kind: 'private-key-block', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g },
  { kind: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { kind: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._-]{20,}\b/g },
  {
    kind: 'generic-secret-assignment',
    re: /\b(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['"]?[A-Za-z0-9._/+-]{12,}['"]?/gi,
  },
];

export interface Detection {
  kind: string;
  count: number;
}

/** Detect secret matches in text. Returns per-kind counts (no values). */
export function detectSecrets(text: string, allow: RegExp[]): Detection[] {
  const counts = new Map<string, number>();
  for (const p of PATTERNS) {
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
  return [...counts.entries()].map(([kind, count]) => ({ kind, count }));
}

/** Redact secret matches in text, replacing each with `[REDACTED:<kind>]`. */
export function redactSecrets(text: string, allow: RegExp[]): { text: string; redactions: number } {
  let out = text;
  let redactions = 0;
  for (const p of PATTERNS) {
    out = out.replace(new RegExp(p.re.source, p.re.flags), (match) => {
      if (allow.some((a) => a.test(match))) return match;
      redactions += 1;
      return `[REDACTED:${p.kind}]`;
    });
  }
  return { text: out, redactions };
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

/** Deep-clone `value`, redacting every string leaf. Returns [clone, count]. */
function redactDeep(value: unknown, allow: RegExp[], counter: { n: number }): unknown {
  if (typeof value === 'string') {
    const { text, redactions } = redactSecrets(value, allow);
    counter.n += redactions;
    return text;
  }
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, allow, counter));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v, allow, counter);
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

function readConfig(raw: unknown): PromptFirewallConfig {
  const base: PromptFirewallConfig = {
    enabled: false,
    mode: 'warn',
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
    mode: r['mode'] === 'redact' ? 'redact' : r['mode'] === 'block' ? 'block' : 'warn',
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
    'Scans the provider wire for credential leaks before context reaches the LLM API (wrapProviderRunner); warn/redact/block. Opt-in; warn by default.',
  apiVersion: '^0.1.10',
  capabilities: { tools: true },
  defaultConfig: { enabled: false, mode: 'warn', scanResponse: true, allow: [] },
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
        default: 'warn',
        description:
          'warn = detect only; redact = strip secrets from the request/response; block = refuse the request.',
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

          const detections = detectSecrets(collectText(req), cfg.allow);
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
              const redactedReq = redactDeep(req, cfg.allow, counter) as Record<string, unknown>;
              state.requestRedactions += counter.n;
              api.metrics.counter('request_redactions', counter.n);
              const response = await inner(_ctx, redactedReq);
              return cfg.scanResponse ? redactResponse(response, cfg.allow) : response;
            }
          }

          const response = await inner(_ctx, request);
          if (cfg.mode === 'redact' && cfg.scanResponse) {
            return redactResponse(response, cfg.allow);
          }
          return response;
        },
      } as never);
    }

    // Redact secrets echoed back in the provider response's content.
    function redactResponse(response: unknown, allow: RegExp[]): unknown {
      if (!response || typeof response !== 'object') return response;
      const counter = { n: 0 };
      const content = (response as { content?: unknown }).content;
      if (content === undefined) return response;
      const redacted = redactDeep(content, allow, counter);
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
          counters: {
            invocations: state.invocations,
            requestsWithSecrets: state.requestsWithSecrets,
            requestRedactions: state.requestRedactions,
            responseRedactions: state.responseRedactions,
            blocked: state.blocked,
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
