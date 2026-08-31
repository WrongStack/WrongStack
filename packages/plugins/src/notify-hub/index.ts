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
 * Each webhook delivery POSTs a compact JSON body with the following
 * shape (the original event payload is preserved via metadata spread
 * at the top level):
 *
 * ```json
 * {
 *   "source": "wrongstack/notify-hub",
 *   "event": "<event-name>",
 *   "ts": "<ISO-8601>",
 *   "title": "<notification-title>",
 *   "message": "<notification-body>",
 *   "level": "info|warning|critical",
 *   ...metadata   // original event payload
 * }
 * ```
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
import { lookup } from 'node:dns/promises';
import type { NotificationMessage, NotificationResult } from '@wrongstack/core/notifications';
import type { Logger, Plugin } from '@wrongstack/core/types';
import { safeJsonStringify } from '../runtime/index.js';
import { WebhookNotificationChannel } from './webhook-channel.js';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

/** Captured during setup() — the host logger for structured log lines. */
let _pluginLog: Logger | null = null;

interface NotifyHubState {
  channel: WebhookNotificationChannel | null;
  lastDelivery: { event: string; ok: boolean; when: string } | null;
  stopHookUnregister: null | (() => void);
  eventUnsubscribers: Array<() => void>;
  circuitWarned: boolean;
}

const state: NotifyHubState = {
  channel: null,
  lastDelivery: null,
  stopHookUnregister: null,
  eventUnsubscribers: [],
  circuitWarned: false,
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

/**
 * Resolve `hostname` via DNS and verify that none of the resolved IPs
 * are in private / loopback / link-local ranges. This catches SSRF
 * vectors where a public DNS name (e.g. `127.0.0.1.nip.io`, any
 * `nip.io` / `xip.io` variant, or a custom A/AAAA record) resolves
 * to an internal address that the string-level `normalizeWebhookUrl`
 * validator cannot detect.
 *
 * Resolution failures (NXDOMAIN, timeout, network unreachable) are
 * treated as a soft-pass so transient DNS issues never permanently
 * disable the plugin at setup time — the string-level validator is
 * the primary defense; this is a secondary belt-and-suspenders check.
 *
 * @returns `true` if the hostname is safe or unresolvable
 */
async function hasPrivateResolvedIP(hostname: string): Promise<boolean> {
  try {
    const entries = await lookup(hostname, { all: true, verbatim: true });
    for (const { address } of entries) {
      if (isPrivateIPv4(address)) return true;
      const lower = address.toLowerCase();
      if (
        lower === '::1' ||
        lower === '0:0:0:0:0:0:0:1' ||
        lower.startsWith('fc') ||
        lower.startsWith('fd') ||
        lower.startsWith('fe80:')
      ) {
        return true;
      }
    }
    return false;
  } catch {
    // DNS resolution failure — not reachable or NXDOMAIN.
    // Allow through so a transient outage doesn't brick the plugin.
    return false;
  }
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
  const rawUrl = r['webhookUrl'] ?? r['webhook_url'] ?? r['url'];
  const rawTimeout = r['timeoutMs'] ?? r['timeout_ms'] ?? r['timeout'];
  const rawFailures = r['maxConsecutiveFailures'] ?? r['max_consecutive_failures'] ?? r['maxFailures'] ?? r['max_failures'];
  return {
    enabled: r['enabled'] !== false,
    webhookUrl: normalizeWebhookUrl(rawUrl),
    events: Array.isArray(r['events'])
      ? r['events'].filter((e): e is NotifyEvent => KNOWN_EVENTS.includes(e as NotifyEvent))
      : [...DEFAULTS.events],
    headers,
    timeoutMs:
      typeof rawTimeout === 'number' && rawTimeout >= 500 && rawTimeout <= 60_000
        ? rawTimeout
        : DEFAULTS.timeoutMs,
    maxConsecutiveFailures:
      typeof rawFailures === 'number' && rawFailures >= 1
        ? rawFailures
        : DEFAULTS.maxConsecutiveFailures,
  };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

async function deliver(event: string, payload: Record<string, unknown>): Promise<boolean> {
  const ch = state.channel;
  if (!ch) {
    return false;
  }
  const result = await deliverViaChannel(ch, event, {
    title: typeof payload.title === 'string' ? payload.title : event,
    body:
      typeof payload.message === 'string'
        ? payload.message
        : typeof payload.error === 'string'
          ? payload.error
          : safeJsonStringify(payload),
    level: event === 'tool.error' || event === 'budget.threshold' ? 'warning' : 'info',
    source: event,
    metadata: payload,
  });
  return result.ok;
}

/**
 * Send without awaiting, and absorb any failure.
 *
 * A notification is best-effort by definition: it must never block the
 * path that triggered it, and it must never take the process down. A bare
 * `void deliver(…)` satisfies the first requirement but not the second —
 * anything that rejects inside becomes an unhandled rejection with no
 * owner. This is the only spelling used for detached sends.
 */
function deliverDetached(event: string, payload: Record<string, unknown>): void {
  deliver(event, payload).catch((err: unknown) => {
    _pluginLog?.warn('notify-hub: notification delivery failed', {
      event,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Send a notification through the channel and update delivery tracking.
 * Logs circuit-open on the false→true transition (once per trip).
 */
async function deliverViaChannel(
  ch: WebhookNotificationChannel,
  event: string,
  msg: NotificationMessage,
): Promise<NotificationResult> {
  const result = await ch.deliver(msg);
  if (result.ok) {
    state.circuitWarned = false;
    state.lastDelivery = { event, ok: true, when: new Date().toISOString() };
  } else {
    state.lastDelivery = { event, ok: false, when: new Date().toISOString() };
    // Log circuit-open on the false→true transition (once per trip).
    const cs = ch.circuitStatus();
    if (cs.open && !state.circuitWarned) {
      state.circuitWarned = true;
      _pluginLog?.warn(
        `notify-hub: ${cs.consecutiveFailures} consecutive delivery failures — circuit opened, further notifications suppressed`,
        { consecutiveFailures: cs.consecutiveFailures, event },
      );
    }
  }
  return result;
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

  async setup(api) {
    // Idempotent re-init (H1 pattern).
    _pluginLog = api.log;
    state.circuitWarned = false;
    state.channel = null;
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
    let active = cfg.enabled && cfg.webhookUrl.length > 0;

    // ── SSRF defense: resolve hostname via DNS and reject private IPs ────
    // The string-level normalizeWebhookUrl already blocks literal private
    // addresses (localhost, 10.x, 172.16-31.x, 192.168.x, etc.). This DNS
    // layer catches DNS names that resolve to private IPs — a gap that
    // tools like nip.io / xip.io / custom A-records can exploit.
    if (active) {
      try {
        const url = new URL(cfg.webhookUrl);
        const hostnameBlocked = await hasPrivateResolvedIP(url.hostname);
        if (hostnameBlocked) {
          api.log.warn(
            `notify-hub: webhook URL resolves to a private/local IP (${url.hostname}) — disabling plugin`,
          );
          active = false;
        }
      } catch {
        // URL parse failure — should not happen since normalizeWebhookUrl
        // already validated it, but if it does, let setup continue and the
        // channel construction below will fail naturally.
      }
    }

    // ── Webhook notification channel ────────────────────────────────────
    if (active) {
      state.channel = new WebhookNotificationChannel({
        webhookUrl: cfg.webhookUrl,
        headers: cfg.headers,
        timeoutMs: cfg.timeoutMs,
        maxConsecutiveFailures: cfg.maxConsecutiveFailures,
      });
      // Register with the host's Notifier so other subsystems can send
      // to the "webhook" channel without knowing the URL.
      api.notifier?.registerChannel(state.channel);
    }

    // ── session.stop via Stop hook ────────────────────────────────────
    if (active && cfg.events.includes('session.stop')) {
      const stopHook = (input: { cwd?: string | undefined; sessionId?: string | undefined }) => {
        // Fire-and-forget: never block the stop path on network I/O.
        deliverDetached('session.stop', {
          sessionId: input.sessionId ?? null,
          cwd: input.cwd ?? null,
        });
      };
      state.stopHookUnregister = api.registerHook('Stop', undefined, stopHook as never);
    }

    // ── tool.error via event bus ──────────────────────────────────────
    if (active && cfg.events.includes('tool.error')) {
      const off = api.onPattern('tool.*', (eventName: string, payload: unknown) => {
        if (!/error|failed/.test(eventName)) return;
        const p = payload as { tool?: string; name?: string; error?: unknown } | null;
        deliverDetached('tool.error', {
          tool: p?.tool ?? p?.name ?? 'unknown',
          busEvent: eventName,
          error: truncateText(
            p?.error instanceof Error ? p.error.message : String(p?.error ?? ''),
            500,
          ),
        });
      });
      state.eventUnsubscribers.push(off);
    }

    // ── budget.threshold via event bus ────────────────────────────────
    if (active && cfg.events.includes('budget.threshold')) {
      const off = api.onPattern('budget.*', (eventName: string, payload: unknown) => {
        if (!eventName.includes('threshold')) return;
        deliverDetached('budget.threshold', { busEvent: eventName, detail: payload });
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
        message?: string | undefined;
        body?: string | undefined;
        text?: string | undefined;
        content?: string | undefined;
        msg?: string | undefined;
        level?: string | undefined;
      }) {
        if (!cfg.enabled) return { ok: false, error: 'notify-hub is disabled' };
        const ch = state.channel;
        if (!ch) {
          return {
            ok: false,
            error:
              'no webhookUrl configured — set config.extensions["notify-hub"].webhookUrl to enable deliveries',
          };
        }
        const inp = (input ?? {}) as Record<string, unknown>;
        const rawMsg = inp['message'] ?? inp['body'] ?? inp['text'] ?? inp['content'] ?? inp['msg'];
        const message = typeof rawMsg === 'string' && rawMsg.trim().length > 0 ? rawMsg.trim() : '';
        if (!message) return { ok: false, error: 'message is required' };
        const rawTitle = inp['title'] ?? inp['subject'] ?? inp['header'];
        const title = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : 'WrongStack notification';

        const result = await deliverViaChannel(ch, 'manual', {
          title: truncateText(title, 200),
          body: truncateText(message, 2_000),
          level: input.level === 'warning' || input.level === 'critical' ? input.level : 'info',
          source: 'manual',
        });
        return {
          ok: result.ok,
          circuitOpen: ch.circuitStatus().open,
          ...(result.ok ? {} : { error: result.error ?? 'delivery failed' }),
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
        const ch = state.channel;
        const counters = ch?.counters() ?? {
          attempted: 0,
          delivered: 0,
          failed: 0,
          suppressed: 0,
        };
        // The channel tracks absolute totals; legacy state tracks
        // session-scoped counters. Report both.
        return {
          ok: true,
          enabled: cfg.enabled,
          webhookConfigured: cfg.webhookUrl.length > 0,
          events: cfg.events,
          timeoutMs: cfg.timeoutMs,
          circuitOpen: ch?.circuitStatus().open ?? false,
          counters: {
            sent: counters.delivered,
            failed: counters.failed,
            suppressed: counters.suppressed,
            consecutiveFailures: ch?.circuitStatus().consecutiveFailures ?? 0,
            totalAttempted: counters.attempted,
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
    _pluginLog = null;
    state.circuitWarned = false;
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
    if (api.tools?.unregister) {
      try {
        api.tools.unregister('notify_send');
        api.tools.unregister('notify_hub_status');
      } catch {
        // best-effort
      }
    }
    if (api.notifier?.unregisterChannel) {
      try {
        api.notifier.unregisterChannel('webhook');
      } catch {
        // best-effort
      }
    }
    const channelCounters = state.channel?.counters();
    state.channel = null;
    state.lastDelivery = null;
    api.log.info('notify-hub: teardown complete', { channelCounters });
  },

  async health() {
    const ch = state.channel;
    const cs = ch?.circuitStatus();
    const channelCounters = ch?.counters();
    const sent = channelCounters?.delivered ?? 0;
    const failed = channelCounters?.failed ?? 0;
    const suppressed = channelCounters?.suppressed ?? 0;
    return {
      ok: !cs?.open,
      message: cs?.open
        ? `notify-hub: circuit OPEN after ${cs.consecutiveFailures} consecutive failures — deliveries suppressed`
        : ch
          ? `notify-hub: ${sent} sent, ${failed} failed, ${suppressed} suppressed`
          : `notify-hub: idle — no webhook channel configured`,
      counters: { sent, failed, suppressed, consecutiveFailures: cs?.consecutiveFailures ?? 0 },
    };
  },
};

export default plugin;
