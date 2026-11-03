/**
 * HQ notifier — pushes what needs the operator to the channels in
 * `notify.json` (webhook, Slack, Discord, ntfy).
 *
 * Delivery never blocks or crashes the HQ server: every send is
 * fire-and-forget with a timeout, failures are recorded on the channel for
 * the dashboard, and a noisy source cannot flood a channel (per-key dedupe
 * plus a per-channel rate limit).
 *
 * What is sent is a SUMMARY a third party may see: rule messages, hostnames,
 * project names, tool names and question titles — never tool arguments,
 * transcripts or tokens.
 *
 * @module hq/notifier
 */
import { randomUUID } from 'node:crypto';
import { toErrorMessage } from '@wrongstack/core/utils';
import {
  clampApprovalDelay,
  emptyHqNotifyConfig,
  HQ_NOTIFY_APPROVAL_DELAY_BOUNDS,
  HQ_NOTIFY_MAX_CHANNELS,
  type HqNotifyChannel,
  type HqNotifyChannelInput,
  type HqNotifyConfigFile,
  type HqNotifyKind,
  type HqNotifySeverity,
  maskHqNotifyUrl,
  mutateHqNotifyConfig,
  parseHqNotifyChannel,
  readHqNotifyConfig,
  validateHqNotifyUrl,
} from './notify-config.js';

export interface HqNotification {
  kind: HqNotifyKind;
  severity: HqNotifySeverity;
  title: string;
  body: string;
  /** Repeats of the same key inside the dedupe window are dropped. */
  dedupeKey: string;
  /** Dashboard path (`/fleet/machines/?machine=…`); joined to `publicUrl`. */
  path?: string;
  /** The machine this is about (`host:…` / `mid:…`), when it is about one. */
  machineKey?: string;
}

/** What the dashboard sees of a channel: no URL, only its masked form. */
export interface HqNotifyChannelView {
  id: string;
  name: string;
  type: HqNotifyChannel['type'];
  maskedUrl: string;
  enabled: boolean;
  kinds: readonly HqNotifyKind[];
  minSeverity: HqNotifySeverity;
  machineLabels: readonly string[];
  lastDeliveredAt?: string;
  lastError?: { at: string; message: string };
  delivered: number;
  dropped: number;
}

export interface HqNotifySettingsView {
  publicUrl?: string;
  approvalDelaySeconds: number;
  channels: HqNotifyChannelView[];
}

export type HqNotifyMutation<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };

interface ChannelStatus {
  lastDeliveredAt?: string;
  lastError?: { at: string; message: string };
  delivered: number;
  dropped: number;
  /** Send timestamps inside the rate window. */
  recent: number[];
}

const SEVERITY_RANK: Record<HqNotifySeverity, number> = { info: 0, warn: 1, error: 2 };
const DEDUPE_WINDOW_MS = 10 * 60_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 10;
const SEND_TIMEOUT_MS = 8_000;
const MAX_DEDUPE_KEYS = 2_000;

type FetchLike = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number }>;

function clipText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/**
 * Slack mrkdwn: `&`, `<` and `>` are its control characters (`<!channel>`,
 * `<url|label>`). Titles and bodies carry client data — question titles are
 * model output — so they are escaped before Slack sees them.
 */
function slackEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Discord markdown: backslash-escape what could format, hide or mask a link. */
function discordEscape(text: string): string {
  return text.replace(/[\\*_~`|>#[\]()-]/g, (char) => `\\${char}`);
}

/** Where a notification links: `publicUrl` keeps its own path prefix. */
function hqNotificationLink(
  publicUrl: string | undefined,
  path: string | undefined,
): string | undefined {
  if (publicUrl === undefined || path === undefined) return undefined;
  const base = publicUrl.endsWith('/') ? publicUrl : `${publicUrl}/`;
  return new URL(path.replace(/^\/+/, ''), base).toString();
}

/** The request one channel type expects. */
function hqNotificationRequest(
  channel: Pick<HqNotifyChannel, 'type' | 'url'>,
  note: HqNotification,
  link: string | undefined,
  at: string,
): { url: string; init: RequestInit } {
  const title = clipText(note.title, 200);
  const body = clipText(note.body, 1_500);
  const json = (url: string, payload: unknown): { url: string; init: RequestInit } => ({
    url,
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
  });
  switch (channel.type) {
    case 'slack':
      return json(channel.url, {
        text: `*${slackEscape(title)}*\n${slackEscape(body)}${
          link ? `\n<${slackEscape(link)}|Open in WrongStack HQ>` : ''
        }`,
      });
    case 'discord':
      return json(channel.url, {
        content: clipText(
          `**${discordEscape(title)}**\n${discordEscape(body)}${link ? `\n<${link}>` : ''}`,
          2_000,
        ),
        allowed_mentions: { parse: [] },
      });
    case 'ntfy': {
      // JSON publishing (POST to the server root with the topic in the body)
      // keeps non-ASCII titles out of HTTP headers.
      const parsed = new URL(channel.url);
      const topic = parsed.pathname.replace(/^\/+|\/+$/g, '');
      const root = `${parsed.origin}/${parsed.search}`;
      return json(root, {
        topic,
        title,
        message: body,
        priority: note.severity === 'error' ? 5 : note.severity === 'warn' ? 4 : 3,
        tags: [
          note.kind === 'alert'
            ? 'rotating_light'
            : note.kind === 'machine'
              ? 'computer'
              : 'raising_hand',
        ],
        ...(link ? { click: link } : {}),
      });
    }
    default:
      return json(channel.url, {
        type: 'wrongstack.hq.notification',
        version: 1,
        kind: note.kind,
        severity: note.severity,
        title,
        body,
        ...(link ? { link } : {}),
        at,
      });
  }
}

export class HqNotifier {
  private config: HqNotifyConfigFile = emptyHqNotifyConfig();
  private readonly status = new Map<string, ChannelStatus>();
  private readonly sentKeys = new Map<string, number>();
  private labelsOf: (machineKey: string) => readonly string[] = () => [];
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly inflight = new Set<Promise<void>>();

  constructor(
    private readonly dataDir: string,
    opts: { fetch?: FetchLike; now?: () => number } = {},
  ) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.now = opts.now ?? Date.now;
  }

  /** Seed from disk. A corrupt file leaves notifications off and says why. */
  async load(): Promise<void> {
    try {
      this.config = await readHqNotifyConfig(this.dataDir);
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'hq.notify_config_unreadable',
          message: toErrorMessage(err),
        }),
      );
    }
  }

  approvalDelayMs(): number {
    return (this.config.approvalDelaySeconds ?? HQ_NOTIFY_APPROVAL_DELAY_BOUNDS.default) * 1_000;
  }

  /** True when at least one enabled channel wants this kind. */
  wants(kind: HqNotifyKind): boolean {
    return this.config.channels.some((channel) => channel.enabled && channel.kinds.includes(kind));
  }

  /** Send to every enabled channel that wants it. Never throws. */
  notify(note: HqNotification): void {
    const now = this.now();
    const last = this.sentKeys.get(note.dedupeKey);
    if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return;
    const targets = this.config.channels.filter(
      (channel) =>
        channel.enabled &&
        channel.kinds.includes(note.kind) &&
        (note.kind !== 'alert' ||
          SEVERITY_RANK[note.severity] >= SEVERITY_RANK[channel.minSeverity]) &&
        this.aboutChannelMachines(channel, note),
    );
    if (targets.length === 0) return;
    let sent = false;
    for (const channel of targets) {
      const status = this.statusOf(channel.id);
      status.recent = status.recent.filter((at) => now - at < RATE_WINDOW_MS);
      if (status.recent.length >= RATE_LIMIT) {
        status.dropped += 1;
        continue;
      }
      status.recent.push(now);
      sent = true;
      this.track(this.deliver(channel, note));
    }
    // Only a note that went out is a repeat later: one every channel held
    // back for its rate limit may come through on the next attempt.
    if (!sent) return;
    this.sentKeys.set(note.dedupeKey, now);
    if (this.sentKeys.size > MAX_DEDUPE_KEYS) {
      for (const [key, at] of this.sentKeys) {
        if (now - at >= DEDUPE_WINDOW_MS || this.sentKeys.size > MAX_DEDUPE_KEYS) {
          this.sentKeys.delete(key);
        }
      }
    }
  }

  /**
   * Where operator labels come from (the machine roster). Until it is set, a
   * label-limited channel hears only notifications about no single machine.
   */
  setMachineLabels(labelsOf: (machineKey: string) => readonly string[]): void {
    this.labelsOf = labelsOf;
  }

  private aboutChannelMachines(channel: HqNotifyChannel, note: HqNotification): boolean {
    const wanted = channel.machineLabels ?? [];
    if (wanted.length === 0 || note.machineKey === undefined) return true;
    const labels = this.labelsOf(note.machineKey);
    return wanted.some((label) => labels.includes(label));
  }

  /** Send a test message to one channel and report the outcome. */
  async test(id: string): Promise<HqNotifyMutation<{ delivered: true }>> {
    const channel = this.config.channels.find((entry) => entry.id === id);
    if (channel === undefined) return { ok: false, status: 404, error: 'Unknown channel.' };
    const error = await this.deliver(channel, {
      kind: 'alert',
      severity: 'info',
      title: 'WrongStack HQ test notification',
      body: `Channel "${channel.name}" is connected. HQ will send ${channel.kinds.join(', ')} here.`,
      dedupeKey: `test:${randomUUID()}`,
      path: '/system/notifications/',
    });
    return error === null
      ? { ok: true, value: { delivered: true } }
      : { ok: false, status: 502, error };
  }

  view(): HqNotifySettingsView {
    return {
      ...(this.config.publicUrl !== undefined ? { publicUrl: this.config.publicUrl } : {}),
      approvalDelaySeconds:
        this.config.approvalDelaySeconds ?? HQ_NOTIFY_APPROVAL_DELAY_BOUNDS.default,
      channels: this.config.channels.map((channel) => {
        const status = this.statusOf(channel.id);
        return {
          id: channel.id,
          name: channel.name,
          type: channel.type,
          maskedUrl: maskHqNotifyUrl(channel.url),
          enabled: channel.enabled,
          kinds: channel.kinds,
          minSeverity: channel.minSeverity,
          machineLabels: channel.machineLabels ?? [],
          ...(status.lastDeliveredAt !== undefined
            ? { lastDeliveredAt: status.lastDeliveredAt }
            : {}),
          ...(status.lastError !== undefined ? { lastError: status.lastError } : {}),
          delivered: status.delivered,
          dropped: status.dropped,
        };
      }),
    };
  }

  async addChannel(input: HqNotifyChannelInput): Promise<HqNotifyMutation<HqNotifyChannelView>> {
    const parsed = parseHqNotifyChannel(input, randomUUID().slice(0, 8));
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
    // The cap is checked against the file under its lock, so two adds at
    // once cannot both pass it.
    let full = false;
    await this.mutate((file) => {
      full = file.channels.length >= HQ_NOTIFY_MAX_CHANNELS;
      return full ? file : { ...file, channels: [...file.channels, parsed.channel] };
    });
    if (full) {
      return { ok: false, status: 409, error: `At most ${HQ_NOTIFY_MAX_CHANNELS} channels.` };
    }
    return this.viewResult(parsed.channel.id);
  }

  async updateChannel(
    id: string,
    input: HqNotifyChannelInput,
  ): Promise<HqNotifyMutation<HqNotifyChannelView>> {
    const base = this.config.channels.find((channel) => channel.id === id);
    if (base === undefined) return { ok: false, status: 404, error: 'Unknown channel.' };
    const parsed = parseHqNotifyChannel(input, id, base);
    if (!parsed.ok) return { ok: false, status: 400, error: parsed.error };
    await this.mutate((file) => ({
      ...file,
      channels: file.channels.map((channel) => (channel.id === id ? parsed.channel : channel)),
    }));
    return this.viewResult(id);
  }

  async removeChannel(id: string): Promise<HqNotifyMutation<{ removed: string }>> {
    if (!this.config.channels.some((channel) => channel.id === id)) {
      return { ok: false, status: 404, error: 'Unknown channel.' };
    }
    await this.mutate((file) => ({
      ...file,
      channels: file.channels.filter((channel) => channel.id !== id),
    }));
    this.status.delete(id);
    return { ok: true, value: { removed: id } };
  }

  async updateSettings(input: {
    publicUrl?: unknown;
    approvalDelaySeconds?: unknown;
  }): Promise<HqNotifyMutation<HqNotifySettingsView>> {
    let publicUrl = this.config.publicUrl;
    if (input.publicUrl !== undefined) {
      if (input.publicUrl === null || input.publicUrl === '') publicUrl = undefined;
      else {
        const checked = validateHqNotifyUrl(input.publicUrl);
        if (!checked.ok) return { ok: false, status: 400, error: checked.error };
        publicUrl = checked.url;
      }
    }
    let delay = this.config.approvalDelaySeconds;
    if (input.approvalDelaySeconds !== undefined) {
      if (typeof input.approvalDelaySeconds !== 'number') {
        return { ok: false, status: 400, error: 'The approval delay must be a number of seconds.' };
      }
      delay = clampApprovalDelay(input.approvalDelaySeconds);
    }
    await this.mutate(({ publicUrl: _old, ...file }) => ({
      ...file,
      ...(publicUrl !== undefined ? { publicUrl } : {}),
      ...(delay !== undefined ? { approvalDelaySeconds: delay } : {}),
    }));
    return { ok: true, value: this.view() };
  }

  /** Resolves once in-flight deliveries settled. For tests and shutdown. */
  async drain(): Promise<void> {
    while (this.inflight.size > 0) await Promise.allSettled([...this.inflight]);
  }

  /** The channel as saved, or 404 when a concurrent removal won. */
  private viewResult(id: string): HqNotifyMutation<HqNotifyChannelView> {
    const view = this.view().channels.find((channel) => channel.id === id);
    return view === undefined
      ? { ok: false, status: 404, error: 'The channel was removed meanwhile.' }
      : { ok: true, value: view };
  }

  private async mutate(change: (file: HqNotifyConfigFile) => HqNotifyConfigFile): Promise<void> {
    this.config = await mutateHqNotifyConfig(this.dataDir, change);
  }

  private statusOf(id: string): ChannelStatus {
    let status = this.status.get(id);
    if (status === undefined) {
      status = { delivered: 0, dropped: 0, recent: [] };
      this.status.set(id, status);
    }
    return status;
  }

  private track(work: Promise<unknown>): void {
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    this.inflight.add(settled);
    void settled.finally(() => this.inflight.delete(settled));
  }

  /** One delivery. Resolves to null on success, else the reason. */
  private async deliver(channel: HqNotifyChannel, note: HqNotification): Promise<string | null> {
    const at = new Date(this.now()).toISOString();
    const link = hqNotificationLink(this.config.publicUrl, note.path);
    const status = this.statusOf(channel.id);
    let reason: string | null = null;
    try {
      const request = hqNotificationRequest(channel, note, link, at);
      const response = await this.fetchImpl(request.url, {
        ...request.init,
        // A redirect could carry the request (and its URL secret) elsewhere.
        redirect: 'error',
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!response.ok) reason = `The channel answered HTTP ${response.status}.`;
    } catch (err) {
      reason =
        err instanceof Error && err.name === 'TimeoutError'
          ? 'The channel did not answer in time.'
          : 'The channel could not be reached.';
    }
    if (reason === null) {
      status.delivered += 1;
      status.lastDeliveredAt = at;
    } else {
      status.lastError = { at, message: reason };
    }
    return reason;
  }
}
