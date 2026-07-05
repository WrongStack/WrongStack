/**
 * notify-hub plugin — pushes session events to a webhook.
 *
 * Long-running autonomous sessions need a way to reach the user when
 * something noteworthy happens and nobody is watching the terminal.
 * notify-hub POSTs compact JSON payloads to a configurable webhook
 * URL (Slack/Discord-compatible via generic JSON, n8n, ntfy, or any
 * HTTP endpoint) for a configurable set of events:
 *
 *  - `session.stop`      — the agent loop ended (Stop hook)
 *  - `tool.error`        — a tool invocation failed
 *  - `budget.threshold`  — a budget threshold event fired on the bus
 *
 * Deliveries are fire-and-forget with a timeout — a dead webhook can
 * never stall the agent. Failures are counted and reported via
 * `notify_hub_status` / `health()`, and delivery stops trying after
 * `maxConsecutiveFailures` (circuit breaker) until setup runs again.
 *
 * The agent can also send an ad-hoc notification with `notify_send`
 * ("tell the user the migration finished").
 *
 * Config (`config.extensions['notify-hub']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "webhookUrl": "",                  // empty = plugin idles
 *   "events": ["session.stop", "tool.error"],
 *   "headers": {},                     // extra HTTP headers (auth…)
 *   "timeoutMs": 5000,
 *   "maxConsecutiveFailures": 5
 * }
 * ```
 *
 * Toggle off with `{ "name": "notify-hub", "enabled": false }` in
 * `config.plugins`, or `"enabled": false` in the options above.
 *
 * @public
 */
import type { Plugin } from '@wrongstack/core';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface NotifyHubState {
  sent: number;
  failed: number;
  suppressed: number;
  consecutiveFailures: number;
  circuitOpen: boolean;
  lastDelivery: { event: string; ok: boolean; when: string } | null;
  stopHookUnregister: null | (() => void);
  eventUnsubscribers: Array<() => void>;
}

const state: NotifyHubState = {
  sent: 0,
  failed: 0,
  suppressed: 0,
  consecutiveFailures: 0,
  circuitOpen: false,
  lastDelivery: null,
  stopHookUnregister: null,
  eventUnsubscribers: [],
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

type NotifyEvent = 'session.stop' | 'tool.error' | 'budget.threshold';

interface NotifyHubConfig {
  enabled: boolean;
  webhookUrl: string;
  events: NotifyEvent[];
  headers: Record<string, string>;
  timeoutMs: number;
  maxConsecutiveFailures: number;
}

const KNOWN_EVENTS: NotifyEvent[] = ['session.stop', 'tool.error', 'budget.threshold'];

const DEFAULTS: NotifyHubConfig = {
  enabled: true,
  webhookUrl: '',
  events: ['session.stop', 'tool.error'],
  headers: {},
  timeoutMs: 5_000,
  maxConsecutiveFailures: 5,
};

function isPrivateIPv4(hostname: string): boolean {
  const parts = hostname.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '::1' ||
    h === '0:0:0:0:0:0:0:1' ||
    h.startsWith('fc') ||
    h.startsWith('fd') ||
    h.startsWith('fe80:') ||
    isPrivateIPv4(h)
  );
}

function normalizeWebhookUrl(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim().length === 0) return '';
  try {
    const url = new URL(raw.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    if (url.username || url.password) return '';
    if (!url.hostname || isBlockedHostname(url.hostname)) return '';
    url.hash = '';
    return url.toString();
  } catch {
    return '';
  }
}

function readConfig(raw: unknown): NotifyHubConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS, events: [...DEFAULTS.events] };
  const r = raw as Record<string, unknown>;
  const headers: Record<string, string> = {};
  if (r['headers'] && typeof r['headers'] === 'object' && !Array.isArray(r['headers'])) {
    for (const [k, v] of Object.entries(r['headers'] as Record<string, unknown>)) {
      if (typeof v === 'string') headers[k] = v;
    }
  }
  return {
    enabled: r['enabled'] !== false,
    webhookUrl: normalizeWebhookUrl(r['webhookUrl']),
    events: Array.isArray(r['events'])
      ? r['events'].filter((e): e is NotifyEvent => KNOWN_EVENTS.includes(e as NotifyEvent))
      : [...DEFAULTS.events],
    headers,
    timeoutMs:
      typeof r['timeoutMs'] === 'number' && r['timeoutMs'] >= 500 && r['timeoutMs'] <= 60_000
        ? r['timeoutMs']
        : DEFAULTS.timeoutMs,
    maxConsecutiveFailures:
      typeof r['maxConsecutiveFailures'] === 'number' && r['maxConsecutiveFailures'] >= 1
        ? r['maxConsecutiveFailures']
        : DEFAULTS.maxConsecutiveFailures,
  };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

async function deliver(
  cfg: NotifyHubConfig,
  event: string,
  payload: Record<string, unknown>,
  log: { warn(msg: string, meta?: unknown): void },
): Promise<boolean> {
  if (!cfg.webhookUrl) return false;
  if (state.circuitOpen) {
    state.suppressed += 1;
    return false;
  }
  const body = JSON.stringify({
    source: 'wrongstack/notify-hub',
    event,
    ts: new Date().toISOString(),
    ...payload,
  });
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    try {
      const res = await fetch(cfg.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...cfg.headers },
        body,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`webhook responded ${res.status}`);
    } finally {
      clearTimeout(timer);
    }
    state.sent += 1;
    state.consecutiveFailures = 0;
    state.lastDelivery = { event, ok: true, when: new Date().toISOString() };
    return true;
  } catch (err) {
    state.failed += 1;
    state.consecutiveFailures += 1;
    state.lastDelivery = { event, ok: false, when: new Date().toISOString() };
    if (state.consecutiveFailures >= cfg.maxConsecutiveFailures) {
      state.circuitOpen = true;
      log.warn(
        `notify-hub: ${state.consecutiveFailures} consecutive delivery failures — circuit opened, further notifications suppressed`,
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
    return false;
  }
}

function truncateText(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'notify-hub',
  version: '0.1.0',
  description:
    'POSTs session events (stop, tool errors, budget thresholds) and ad-hoc notify_send messages to a configurable webhook',
  apiVersion: '^0.1.10',
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      webhookUrl: {
        type: 'string',
        default: '',
        description: 'HTTP(S) endpoint that receives JSON POSTs. Empty = plugin idles.',
      },
      events: {
        type: 'array',
        items: { type: 'string', enum: KNOWN_EVENTS },
        default: ['session.stop', 'tool.error'],
        description: 'Which events trigger a webhook delivery.',
      },
      headers: {
        type: 'object',
        default: {},
        description: 'Extra HTTP headers sent with every delivery (e.g. Authorization).',
      },
      timeoutMs: {
        type: 'number',
        minimum: 500,
        maximum: 60_000,
        default: 5_000,
        description: 'Per-delivery timeout.',
      },
      maxConsecutiveFailures: {
        type: 'number',
        minimum: 1,
        default: 5,
        description: 'Circuit breaker: stop trying after this many consecutive failures.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.sent = 0;
    state.failed = 0;
    state.suppressed = 0;
    state.consecutiveFailures = 0;
    state.circuitOpen = false;
    state.lastDelivery = null;
    if (state.stopHookUnregister) {
      try {
        state.stopHookUnregister();
      } catch {
        // best-effort
      }
      state.stopHookUnregister = null;
    }
    for (const off of state.eventUnsubscribers) {
      try {
        off();
      } catch {
        // best-effort
      }
    }
    state.eventUnsubscribers = [];

    const cfg = readConfig(api.config.extensions?.['notify-hub']);
    const active = cfg.enabled && cfg.webhookUrl.length > 0;

    // ── session.stop via Stop hook ────────────────────────────────────
    if (active && cfg.events.includes('session.stop')) {
      const stopHook = (input: { cwd?: string | undefined; sessionId?: string | undefined }) => {
        // Fire-and-forget: never block the stop path on network I/O.
        void deliver(
          cfg,
          'session.stop',
          { sessionId: input.sessionId ?? null, cwd: input.cwd ?? null },
          api.log,
        );
      };
      state.stopHookUnregister = api.registerHook('Stop', undefined, stopHook as never);
    }

    // ── tool.error via event bus ──────────────────────────────────────
    if (active && cfg.events.includes('tool.error')) {
      const off = api.onPattern('tool.*', (eventName: string, payload: unknown) => {
        if (!/error|failed/.test(eventName)) return;
        const p = payload as { tool?: string; name?: string; error?: unknown } | null;
        void deliver(
          cfg,
          'tool.error',
          {
            tool: p?.tool ?? p?.name ?? 'unknown',
            busEvent: eventName,
            error: truncateText(
              p?.error instanceof Error ? p.error.message : String(p?.error ?? ''),
              500,
            ),
          },
          api.log,
        );
      });
      state.eventUnsubscribers.push(off);
    }

    // ── budget.threshold via event bus ────────────────────────────────
    if (active && cfg.events.includes('budget.threshold')) {
      const off = api.onPattern('budget.*', (eventName: string, payload: unknown) => {
        if (!eventName.includes('threshold')) return;
        void deliver(cfg, 'budget.threshold', { busEvent: eventName, detail: payload }, api.log);
      });
      state.eventUnsubscribers.push(off);
    }

    // ── notify_send tool ──────────────────────────────────────────────
    api.tools.register({
      name: 'notify_send',
      description:
        'Send an ad-hoc notification to the configured webhook (e.g. "migration finished", "need input"). No-op when notify-hub has no webhookUrl.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short notification title.' },
          message: { type: 'string', description: 'Notification body.' },
          level: {
            type: 'string',
            enum: ['info', 'warning', 'critical'],
            description: 'Severity hint for the receiver (default info).',
          },
        },
        required: ['message'],
      },
      permission: 'auto',
      category: 'Notifications',
      mutating: true,
      async execute(input: {
        title?: string | undefined;
        message: string;
        level?: string | undefined;
      }) {
        if (!cfg.enabled) return { ok: false, error: 'notify-hub is disabled' };
        if (!cfg.webhookUrl) {
          return {
            ok: false,
            error:
              'no webhookUrl configured — set config.extensions["notify-hub"].webhookUrl to enable deliveries',
          };
        }
        const delivered = await deliver(
          cfg,
          'manual',
          {
            title: truncateText(String(input.title ?? 'WrongStack notification'), 200),
            message: truncateText(String(input.message ?? ''), 2_000),
            level: input.level === 'warning' || input.level === 'critical' ? input.level : 'info',
          },
          api.log,
        );
        return {
          ok: delivered,
          circuitOpen: state.circuitOpen,
          ...(delivered ? {} : { error: 'delivery failed (see notify_hub_status)' }),
        };
      },
    });

    // ── notify_hub_status tool ────────────────────────────────────────
    api.tools.register({
      name: 'notify_hub_status',
      description:
        'Reports notify-hub state: webhook configuration (URL redacted), subscribed events, and delivery counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          webhookConfigured: cfg.webhookUrl.length > 0,
          events: cfg.events,
          timeoutMs: cfg.timeoutMs,
          circuitOpen: state.circuitOpen,
          counters: {
            sent: state.sent,
            failed: state.failed,
            suppressed: state.suppressed,
            consecutiveFailures: state.consecutiveFailures,
          },
          lastDelivery: state.lastDelivery,
        };
      },
    });

    api.log.info('notify-hub plugin loaded', {
      version: '0.1.0',
      enabled: cfg.enabled,
      webhookConfigured: cfg.webhookUrl.length > 0,
      events: cfg.events,
    });
  },

  teardown(api) {
    if (state.stopHookUnregister) {
      try {
        state.stopHookUnregister();
      } catch {
        // best-effort
      }
      state.stopHookUnregister = null;
    }
    for (const off of state.eventUnsubscribers) {
      try {
        off();
      } catch {
        // best-effort
      }
    }
    state.eventUnsubscribers = [];
    const final = { sent: state.sent, failed: state.failed, suppressed: state.suppressed };
    state.sent = 0;
    state.failed = 0;
    state.suppressed = 0;
    state.consecutiveFailures = 0;
    state.circuitOpen = false;
    state.lastDelivery = null;
    api.log.info('notify-hub: teardown complete', { final });
  },

  async health() {
    return {
      ok: !state.circuitOpen,
      message: state.circuitOpen
        ? `notify-hub: circuit OPEN after ${state.consecutiveFailures} consecutive failures — deliveries suppressed`
        : `notify-hub: ${state.sent} sent, ${state.failed} failed, ${state.suppressed} suppressed`,
      counters: {
        sent: state.sent,
        failed: state.failed,
        suppressed: state.suppressed,
        consecutiveFailures: state.consecutiveFailures,
      },
    };
  },
};

export default plugin;
