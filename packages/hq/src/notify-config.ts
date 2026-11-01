/**
 * HQ notification channels — `<dataDir>/notify.json`.
 *
 * HQ only helps if it reaches the operator when they are NOT looking at it, so
 * alerts, machines dropping out and approvals left waiting can be pushed to a
 * webhook, Slack, Discord or an ntfy topic (phone push).
 *
 * A channel URL is a CREDENTIAL — a Slack or Discord webhook URL, or an ntfy
 * topic, lets anyone post as HQ — so:
 *   - the file is owner-only (`SECRET_FILE_MODE` + `restrictFilePermissions`);
 *   - the URL is never sent back to a browser, only a masked form;
 *   - URLs are validated: http(s) only, no userinfo, plain `http` only to a
 *     loopback or private-network host.
 *
 * @module hq/notify-config
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  atomicWrite,
  restrictFilePermissions,
  SECRET_FILE_MODE,
  withFileLock,
} from '@wrongstack/persistence';

export const HQ_NOTIFY_CONFIG_VERSION = 1 as const;

export const HQ_NOTIFY_CHANNEL_TYPES = ['webhook', 'slack', 'discord', 'ntfy'] as const;
export type HqNotifyChannelType = (typeof HQ_NOTIFY_CHANNEL_TYPES)[number];

/** What a channel can be told about. */
export const HQ_NOTIFY_KINDS = ['alert', 'machine', 'approval', 'question'] as const;
export type HqNotifyKind = (typeof HQ_NOTIFY_KINDS)[number];

export type HqNotifySeverity = 'info' | 'warn' | 'error';

export const HQ_NOTIFY_MAX_CHANNELS = 20;
const MAX_URL = 2048;
const MAX_NAME = 80;
/** Bounds on how long an approval may wait before HQ pushes it. */
export const HQ_NOTIFY_APPROVAL_DELAY_BOUNDS = { min: 0, max: 3600, default: 60 } as const;

export interface HqNotifyChannel {
  id: string;
  name: string;
  type: HqNotifyChannelType;
  /** Secret. Never leaves the server unmasked. */
  url: string;
  enabled: boolean;
  kinds: readonly HqNotifyKind[];
  /** Alerts below this severity are not sent. Other kinds ignore it. */
  minSeverity: HqNotifySeverity;
}

export interface HqNotifyConfigFile {
  version: typeof HQ_NOTIFY_CONFIG_VERSION;
  updatedAt: string;
  /** Where links in a notification point (the HQ address operators open). */
  publicUrl?: string;
  /** Seconds an approval or question may wait before it is pushed. */
  approvalDelaySeconds?: number;
  channels: HqNotifyChannel[];
}

export function emptyHqNotifyConfig(): HqNotifyConfigFile {
  return { version: HQ_NOTIFY_CONFIG_VERSION, updatedAt: new Date().toISOString(), channels: [] };
}

function hqNotifyConfigFilePath(dataDir: string): string {
  return path.join(dataDir, 'notify.json');
}

const PRIVATE_HOST =
  /^(localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[::1\]|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:local|lan|internal|home\.arpa))$/i;

/**
 * Validate a channel or link URL. Returns the normalized URL or an error
 * sentence for the operator.
 */
export function validateHqNotifyUrl(
  raw: unknown,
): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof raw !== 'string' || raw.trim() === '')
    return { ok: false, error: 'A URL is required.' };
  const value = raw.trim();
  if (value.length > MAX_URL) return { ok: false, error: 'The URL is too long.' };
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, error: 'That is not a valid URL.' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, error: 'Only http and https URLs are allowed.' };
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return { ok: false, error: 'Put credentials in the URL path or query, not before the host.' };
  }
  if (parsed.protocol === 'http:' && !PRIVATE_HOST.test(parsed.hostname)) {
    return {
      ok: false,
      error: 'Plain http is only allowed to a loopback or private-network host; use https.',
    };
  }
  return { ok: true, url: parsed.toString() };
}

/** `https://hooks.slack.com/…a1b2` — enough to recognize, too little to use. */
export function maskHqNotifyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const rest = `${parsed.pathname}${parsed.search}`.replace(/\/$/, '');
    const tail = rest.length > 4 ? rest.slice(-4) : '';
    return `${parsed.origin}/…${tail}`;
  } catch {
    return '…';
  }
}

function isSeverity(value: unknown): value is HqNotifySeverity {
  return value === 'info' || value === 'warn' || value === 'error';
}

export interface HqNotifyChannelInput {
  name?: unknown;
  type?: unknown;
  url?: unknown;
  enabled?: unknown;
  kinds?: unknown;
  minSeverity?: unknown;
}

/**
 * Build a channel from operator input, or say what is wrong. With `base`, the
 * input is a partial update of that channel (a missing URL keeps the old one).
 */
export function parseHqNotifyChannel(
  input: HqNotifyChannelInput,
  id: string,
  base?: HqNotifyChannel,
): { ok: true; channel: HqNotifyChannel } | { ok: false; error: string } {
  const name =
    input.name === undefined && base !== undefined
      ? base.name
      : typeof input.name === 'string'
        ? input.name.trim().slice(0, MAX_NAME)
        : '';
  if (name === '') return { ok: false, error: 'Give the channel a name.' };
  const type = input.type === undefined && base !== undefined ? base.type : input.type;
  if (!HQ_NOTIFY_CHANNEL_TYPES.includes(type as HqNotifyChannelType)) {
    return {
      ok: false,
      error: `Channel type must be one of ${HQ_NOTIFY_CHANNEL_TYPES.join(', ')}.`,
    };
  }
  let url = base?.url;
  if (input.url !== undefined || base === undefined) {
    const checked = validateHqNotifyUrl(input.url);
    if (!checked.ok) return checked;
    url = checked.url;
  }
  const kinds =
    input.kinds === undefined && base !== undefined
      ? base.kinds
      : Array.isArray(input.kinds)
        ? HQ_NOTIFY_KINDS.filter((kind) => (input.kinds as unknown[]).includes(kind))
        : [];
  if (kinds.length === 0) return { ok: false, error: 'Pick at least one thing to be told about.' };
  const minSeverity =
    input.minSeverity === undefined ? (base?.minSeverity ?? 'warn') : input.minSeverity;
  if (!isSeverity(minSeverity)) return { ok: false, error: 'Unknown minimum severity.' };
  const enabled = input.enabled === undefined ? (base?.enabled ?? true) : input.enabled === true;
  return {
    ok: true,
    channel: {
      id,
      name,
      type: type as HqNotifyChannelType,
      url: url as string,
      enabled,
      kinds,
      minSeverity,
    },
  };
}

/** Re-validate a stored file; entries that no longer validate are dropped. */
function sanitize(raw: unknown): HqNotifyConfigFile {
  const file = emptyHqNotifyConfig();
  if (typeof raw !== 'object' || raw === null) return file;
  const record = raw as Record<string, unknown>;
  if (typeof record.publicUrl === 'string') {
    const checked = validateHqNotifyUrl(record.publicUrl);
    if (checked.ok) file.publicUrl = checked.url;
  }
  if (typeof record.approvalDelaySeconds === 'number') {
    file.approvalDelaySeconds = clampApprovalDelay(record.approvalDelaySeconds);
  }
  const seen = new Set<string>();
  for (const entry of Array.isArray(record.channels) ? record.channels : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,40}$/.test(id) || seen.has(id)) continue;
    const parsed = parseHqNotifyChannel(entry as HqNotifyChannelInput, id);
    if (!parsed.ok) continue;
    seen.add(id);
    file.channels.push(parsed.channel);
    if (file.channels.length >= HQ_NOTIFY_MAX_CHANNELS) break;
  }
  return file;
}

export function clampApprovalDelay(value: number): number {
  const { min, max } = HQ_NOTIFY_APPROVAL_DELAY_BOUNDS;
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : 60;
}

/** Read `notify.json`. Missing → empty; corrupt → empty (logged by the caller). */
export async function readHqNotifyConfig(dataDir: string): Promise<HqNotifyConfigFile> {
  let raw: string;
  try {
    raw = await fs.readFile(hqNotifyConfigFilePath(dataDir), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyHqNotifyConfig();
    throw err;
  }
  return sanitize(JSON.parse(raw.replace(/^﻿/, '')));
}

export async function writeHqNotifyConfig(
  dataDir: string,
  file: HqNotifyConfigFile,
): Promise<void> {
  const target = hqNotifyConfigFilePath(dataDir);
  const payload: HqNotifyConfigFile = {
    ...file,
    version: HQ_NOTIFY_CONFIG_VERSION,
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(dataDir, { recursive: true });
  await atomicWrite(target, `${JSON.stringify(payload, null, 2)}\n`, { mode: SECRET_FILE_MODE });
  await restrictFilePermissions(target, { label: 'hq-notify-config' });
}

/** Locked read → mutate → write. */
export async function mutateHqNotifyConfig(
  dataDir: string,
  mutator: (current: HqNotifyConfigFile) => HqNotifyConfigFile,
): Promise<HqNotifyConfigFile> {
  return withFileLock(
    hqNotifyConfigFilePath(dataDir),
    async () => {
      const next = mutator(await readHqNotifyConfig(dataDir));
      await writeHqNotifyConfig(dataDir, next);
      return next;
    },
    { timeoutMs: 30_000, staleMs: 30_000 },
  );
}
