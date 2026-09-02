import { DefaultSecretScrubber } from '../security/secret-scrubber.js';
import {
  DEFAULT_HQ_REDACTION_POLICY,
  type HqEventEnvelope,
  type HqRedactionPolicy,
} from './protocol.js';

const RAW_CONTENT_REPLACEMENT = '[REDACTED:hq_raw_content]';
const SENSITIVE_FIELD_REPLACEMENT = '[REDACTED:hq_sensitive_field]';
const REDACTED_PATH_REPLACEMENT = '[REDACTED:hq_path]';

const RAW_CONTENT_KEYS = new Set([
  'content',
  'contents',
  'raw',
  'rawContent',
  'body',
  'message',
  'messages',
  'prompt',
  'prompts',
  'completion',
  'response',
  'text',
  'partialText',
  'assistantMessage',
  'userMessage',
  'stdout',
  'stderr',
  'output',
  'toolInput',
  'toolOutput',
  'outputSummary',
  'body',
  'mailboxBody',
  'messageBody',
  'outcome',
  'fileContent',
  'diff',
  'patch',
  'transcript',
  'logs',
]);

// Kanban records are an explicitly configured project-state synchronization
// channel, not telemetry summaries. Their user-authored fields must round-trip
// intact; sensitive-key and secret-pattern scrubbing still applies recursively.
const HQ_PROJECT_STATE_EVENT_TYPES = new Set(['kanban.snapshot']);

const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'apikey',
  'clientSecret',
  'privateKey',
]);

const PATH_KEYS = new Set([
  'path',
  'paths',
  'file',
  'files',
  'filepath',
  'filePath',
  'filename',
  'projectRoot',
  'projectRootDisplay',
  'cwd',
  'workingDir',
  'workingDirectory',
]);

export interface HqRedactOptions {
  policy?: Partial<HqRedactionPolicy>;
  projectRoot?: string;
  maxSummaryLength?: number;
}

export interface HqRedactionResult<T> {
  value: T;
  redacted: boolean;
}

const defaultScrubber = new DefaultSecretScrubber();

export function resolveHqRedactionPolicy(policy?: Partial<HqRedactionPolicy>): HqRedactionPolicy {
  return {
    ...DEFAULT_HQ_REDACTION_POLICY,
    ...policy,
  };
}

/**
 * Apply an operator policy as a one-way privacy clamp. An override can make a
 * publisher policy stricter, but can never enable raw content or broader path
 * / tool-argument disclosure than the publisher selected.
 */
export function tightenHqRedactionPolicy(
  publisherPolicy: HqRedactionPolicy,
  operatorPolicy?: Partial<HqRedactionPolicy>,
): HqRedactionPolicy {
  if (operatorPolicy === undefined) return publisherPolicy;
  const toolRank: Record<HqRedactionPolicy['toolArgs'], number> = {
    none: 0,
    summary: 1,
    redacted: 2,
    full: 3,
  };
  const pathRank: Record<HqRedactionPolicy['paths'], number> = {
    none: 0,
    redacted: 0,
    'project-relative': 1,
    full: 2,
  };
  const requestedToolArgs = operatorPolicy.toolArgs;
  const requestedPaths = operatorPolicy.paths;
  return {
    rawContent:
      publisherPolicy.rawContent &&
      (operatorPolicy.rawContent === undefined || operatorPolicy.rawContent),
    toolArgs:
      requestedToolArgs !== undefined &&
      toolRank[requestedToolArgs] < toolRank[publisherPolicy.toolArgs]
        ? requestedToolArgs
        : publisherPolicy.toolArgs,
    paths:
      requestedPaths !== undefined && pathRank[requestedPaths] < pathRank[publisherPolicy.paths]
        ? requestedPaths
        : publisherPolicy.paths,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    SENSITIVE_KEYS.has(key) ||
    lower.includes('authorization') ||
    lower.includes('password') ||
    lower.includes('secret') ||
    lower.endsWith('token') ||
    lower.endsWith('apikey') ||
    lower.endsWith('api_key') ||
    // H-7 (security report VF-08): the hyphenated spelling — `x-api-key` is
    // the literal Anthropic header name. Parity with the scrubber's
    // `api[-_]?key` and config-secrets' SECRET_KEY_PATTERN.
    lower.endsWith('api-key')
  );
}

function isRawContentKey(key: string): boolean {
  return RAW_CONTENT_KEYS.has(key) || RAW_CONTENT_KEYS.has(key.toLowerCase());
}

function isPathKey(key: string): boolean {
  return PATH_KEYS.has(key) || PATH_KEYS.has(key.toLowerCase());
}

function normalizePathForCompare(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/g, '');
}

function redactPath(
  value: string,
  projectRoot: string | undefined,
  policy: HqRedactionPolicy,
): string {
  if (policy.paths === 'full') return value;
  if (policy.paths === 'none' || policy.paths === 'redacted') return REDACTED_PATH_REPLACEMENT;

  const normalizedValue = normalizePathForCompare(value);
  if (!projectRoot) return normalizedValue.split('/').at(-1) ?? REDACTED_PATH_REPLACEMENT;

  const normalizedRoot = normalizePathForCompare(projectRoot);
  if (normalizedValue === normalizedRoot) return '.';
  if (normalizedValue.startsWith(`${normalizedRoot}/`)) {
    return normalizedValue.slice(normalizedRoot.length + 1) || '.';
  }
  return normalizedValue.split('/').at(-1) ?? REDACTED_PATH_REPLACEMENT;
}

function summarizeString(value: string, maxSummaryLength: number, scrub: boolean): string {
  const scrubbed = scrub ? defaultScrubber.scrub(value) : value;
  if (scrubbed.length <= maxSummaryLength) return scrubbed;
  return `${scrubbed.slice(0, maxSummaryLength)}…[truncated:${scrubbed.length - maxSummaryLength}]`;
}

/**
 * Scrub a free-text preview field and truncate it to a maximum length so
 * it is safe to embed in HQ event envelopes and broadcast to browsers
 * without leaking secrets or running away on unbounded input.
 *
 * Returns `undefined` when the input is empty or non-string. Truncation
 * suffix is `"…[truncated:N]"` where N is the number of dropped chars.
 */
export function scrubAndTruncateHqPreview(
  value: unknown,
  maxLength: number = 280,
): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return summarizeString(value, maxLength, true);
}

function visitValue(
  value: unknown,
  options: {
    policy: HqRedactionPolicy;
    projectRoot?: string;
    maxSummaryLength: number;
    preserveRawContentKeys?: boolean;
    seen: WeakSet<object>;
  },
  key?: string,
): { value: unknown; redacted: boolean } {
  // WS-007: secret scrubbing and sensitive-field masking are unconditional.
  // `rawContent` governs whether *body* content is collapsed to a placeholder —
  // it must never disable the credential defences. Both were previously gated on
  // `!rawContent`, and since the shipped default is `rawContent: true`, neither
  // ran out of the box.
  if (key !== undefined && isSensitiveKey(key)) {
    return { value: SENSITIVE_FIELD_REPLACEMENT, redacted: true };
  }

  if (typeof value === 'string') {
    if (key !== undefined && isPathKey(key)) {
      const redactedPath = redactPath(value, options.projectRoot, options.policy);
      return { value: redactedPath, redacted: redactedPath !== value };
    }

    if (
      !options.preserveRawContentKeys &&
      !options.policy.rawContent &&
      key !== undefined &&
      isRawContentKey(key)
    ) {
      return { value: RAW_CONTENT_REPLACEMENT, redacted: true };
    }

    // Always scrub. Truncation still respects the policy's summary length, but
    // credential patterns are stripped regardless of `rawContent` (WS-007).
    const scrubbed = summarizeString(value, options.maxSummaryLength, true);
    return { value: scrubbed, redacted: scrubbed !== value };
  }

  if (value === null || typeof value !== 'object') return { value, redacted: false };

  if (options.seen.has(value)) return { value: '[REDACTED:hq_circular]', redacted: true };
  options.seen.add(value);

  if (Array.isArray(value)) {
    let redacted = false;
    const out = value.map((item) => {
      const next = visitValue(item, options, key);
      redacted ||= next.redacted;
      return next.value;
    });
    return { value: out, redacted };
  }

  if (!isPlainObject(value)) return { value: String(value), redacted: true };

  let redacted = false;
  const out: Record<string, unknown> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    const next = visitValue(childValue, options, childKey);
    redacted ||= next.redacted;
    out[childKey] = next.value;
  }
  return { value: out, redacted };
}

function redactHqValueInternal<T>(
  value: T,
  options: HqRedactOptions,
  preserveRawContentKeys: boolean,
): HqRedactionResult<T> {
  const result = visitValue(value, {
    policy: resolveHqRedactionPolicy(options.policy),
    ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
    maxSummaryLength: options.maxSummaryLength ?? 500,
    preserveRawContentKeys,
    seen: new WeakSet<object>(),
  });
  return { value: result.value as T, redacted: result.redacted };
}

export function redactHqValue<T>(value: T, options: HqRedactOptions = {}): HqRedactionResult<T> {
  return redactHqValueInternal(value, options, false);
}

/**
 * Redact a payload exactly as it would be redacted when published under `type`.
 *
 * Exported because a sender sometimes needs to know what will go on the wire
 * before it commits to sending — the Kanban→HQ sync measures a board against
 * HQ's per-board byte limit, and HQ drops an over-limit frame without a reply.
 * That measurement has to run the SAME transform as the send, because the
 * event type decides whether raw-content keys survive: `kanban.snapshot` is a
 * project-state event and keeps them, while the generic `redactHqValue` path
 * replaces them with a short marker. Measuring through the generic path made
 * the estimate smaller than reality, so an oversized board could pass the check
 * and still be rejected — the exact silent loss the check exists to prevent.
 */
export function redactHqEventPayload<TPayload>(
  type: string,
  payload: TPayload,
  options: HqRedactOptions = {},
): HqRedactionResult<TPayload> {
  return redactHqValueInternal(payload, options, HQ_PROJECT_STATE_EVENT_TYPES.has(type));
}

export function redactHqEvent<TPayload>(
  event: HqEventEnvelope<TPayload>,
  options: HqRedactOptions = {},
): HqRedactionResult<HqEventEnvelope<TPayload>> {
  const payload = redactHqEventPayload(event.type, event.payload, options);
  const nextEvent = {
    ...event,
    payload: payload.value,
  };
  return { value: nextEvent, redacted: payload.redacted };
}

export function summarizeHqToolArgs(value: unknown, options: HqRedactOptions = {}): unknown {
  const policy = resolveHqRedactionPolicy(options.policy);
  // 'full' keeps the argument *shape* (no summarising, no truncation) but still
  // runs the scrubber and the sensitive-key mask — returning `value` verbatim
  // shipped raw tool arguments, which routinely carry tokens (WS-007).
  if (policy.toolArgs === 'full') return redactHqValue(value, options).value;
  if (policy.toolArgs === 'none') return '[REDACTED:hq_tool_args]';
  if (policy.toolArgs === 'redacted') return redactHqValue(value, options).value;

  if (value === null || typeof value !== 'object') return redactHqValue(value, options).value;
  if (Array.isArray(value)) return `[array:${value.length}]`;

  const entries = Object.entries(value as Record<string, unknown>);
  const summary: Record<string, unknown> = {};
  for (const [key, item] of entries.slice(0, 20)) {
    if (isSensitiveKey(key)) {
      summary[key] = SENSITIVE_FIELD_REPLACEMENT;
    } else if (typeof item === 'string') {
      summary[key] = isPathKey(key)
        ? redactPath(item, options.projectRoot, policy)
        : summarizeString(item, 120, true);
    } else if (Array.isArray(item)) {
      summary[key] = `[array:${item.length}]`;
    } else if (item !== null && typeof item === 'object') {
      summary[key] = '[object]';
    } else {
      summary[key] = item;
    }
  }
  if (entries.length > 20) summary.__truncatedKeys = entries.length - 20;
  return summary;
}
