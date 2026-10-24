import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FetchError } from '@wrongstack/contracts/types/errors';
import { resolveWstackPaths } from '../utils/wstack-paths.js';
import type { TypeSafeBreaker } from './breaker.js';

/**
 * One recorded Jev request.
 *
 * The block of fields up to `answers` is the metadata tail the browser and the
 * TUI render. `request`, `response` and `error` are the opt-in FULL record
 * (see {@link ObserveJevClientOptions.logContent}) and reach disk only: the
 * entry is stripped as it enters the in-process tail, so no surface that reads
 * `jevActivitySnapshot()` can see a payload.
 */
export interface JevActivity {
  id: string;
  at: number;
  feature: string;
  purpose?: 'runtime' | 'self-test' | undefined;
  project: string;
  route: string;
  model: string;
  durationMs: number;
  outcome: 'answered' | 'incomplete' | 'fallback';
  reason?: string | undefined;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  answers?: Record<string, number | string> | undefined;
  /** Everything sent to Jev: state, typed questions and instructions. */
  request?: unknown;
  /** Everything Jev returned: typed answers, distributions, legend, usage. */
  response?: unknown;
  /** Name, message and status of the failure that produced this record. */
  error?: unknown;
}

/**
 * Upper bound on one recorded payload.
 *
 * Rotation at 5 MB only helps while a single LINE can be smaller than that: a
 * multi-megabyte `state` blob would otherwise write a "line" no JSON reader can
 * parse and that rotation can never split. Debug material is disposable, so an
 * oversized record is cut and says so — never silently partial.
 */
const CONTENT_MAX_CHARS = 256 * 1024;

/** Environment override for the directory the JSONL log is written to. */
const LOG_DIR_ENV = 'WRONGSTACK_JEV_LOG_DIR';

const entries: JevActivity[] = [];
let pending = Promise.resolve();
let writeError: string | undefined;
let file: string | undefined;

/**
 * Process-scoped live tail; disk files survive restarts.
 *
 * Never carries request state, question instructions, response legends or raw
 * errors — `recordJevActivity` strips them before an entry reaches this array.
 */
export function jevActivitySnapshot() {
  return { entries: entries.slice().reverse(), path: file, writeError, scope: 'process' as const };
}

/** Metadata half of an entry — what a surface may render. */
function tailEntry(entry: JevActivity): JevActivity {
  const { request, response, error, ...summary } = entry;
  void request;
  void response;
  void error;
  return summary;
}

/** Serialized by recordJevActivity; split for filesystem regression coverage. */
export async function appendJevActivity(target: string, entry: JevActivity): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  const size = await stat(target).then(
    (s) => s.size,
    (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return 0;
      throw error;
    },
  );
  if (size > 5 * 1024 * 1024) await rename(target, `${target}.1`);
  await appendFile(target, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

export function recordJevActivity(entry: JevActivity): void {
  // Strip on the way IN rather than on the way out. Content exists on disk and
  // nowhere else, so a browser snapshot cannot leak it and a 300-entry ring
  // can never be asked to hold 300 request states.
  entries.push(tailEntry(entry));
  if (entries.length > 300) entries.shift();
  const override = process.env[LOG_DIR_ENV]?.trim();
  // Tests must not write into the developer's actual profile — unless the
  // directory was named explicitly, which is how the log path is covered.
  if (process.env['VITEST'] && !override) return;
  try {
    file ??= join(
      override || join(resolveWstackPaths({ projectRoot: process.cwd() }).globalRoot, 'logs'),
      `jev-${process.pid}.jsonl`,
    );
  } catch {
    writeError = 'Could not resolve Jev activity log path';
    return;
  }
  const target = file;
  pending = pending
    .then(async () => {
      await appendJevActivity(target, entry);
      writeError = undefined;
    })
    .catch(() => {
      writeError = 'Could not write Jev activity log';
    });
}

export interface ObserveJevClientOptions {
  /**
   * Record the full request, the full response and the failure, not just the
   * attribution fields.
   *
   * Off by default and opt-in per profile. A Jev request carries whatever
   * evidence the calling feature assembled — recalled memories, prompt
   * fragments, tool state — which is the same material the session log already
   * keeps, and there is a real answer to "what exactly was this feature asked?"
   * that no metadata field can give. But a log that writes the world because a
   * log is there is a different product, so it is something you turn on.
   */
  logContent?: boolean | undefined;
  /**
   * Literal strings scrubbed from recorded content — the account key. The key
   * travels in a header and is never sent, but a `state` blob assembled from
   * arbitrary text can still carry one, and a credential does not belong in a
   * debug log even a private one.
   */
  secrets?: readonly string[] | undefined;
}

/**
 * JSON round-trip of one payload, scrubbed and size-capped.
 *
 * Returns the scrubbed VALUE, not the text, so the record is parsed by the same
 * `JSON.stringify` that writes it and a consumer reading the file sees the
 * payload it sent rather than an encoded copy of it.
 */
function recordedContent(value: unknown, secrets: readonly string[]): unknown {
  let text: string;
  try {
    text = JSON.stringify(value) ?? 'null';
  } catch {
    // A state blob can hold a cycle or a BigInt. A missing record is still a
    // record; a throw here would turn a judgment into an exception.
    return '[unserializable]';
  }
  for (const secret of secrets) {
    // A short "secret" is an ordinary word far more often than a credential,
    // and replacing it would corrupt every record to protect nothing.
    if (secret.length >= 8) text = text.split(secret).join('[redacted]');
  }
  if (text.length > CONTENT_MAX_CHARS)
    return `[truncated: ${text.length} chars, limit ${CONTENT_MAX_CHARS}]`;
  return JSON.parse(text);
}

export function observeJevClient(
  client: TypeSafeBreaker,
  route: string,
  model: string,
  opts: ObserveJevClientOptions = {},
): TypeSafeBreaker {
  const secrets = opts.secrets ?? [];
  const logContent = opts.logContent === true;
  return {
    get paymentRequired() {
      return client.paymentRequired === true;
    },
    get open() {
      return client.open;
    },
    async systemOne(req, signal) {
      const start = Date.now();
      const base = {
        id: randomUUID(),
        at: start,
        feature: req.activityFeature ?? 'evaluation',
        purpose: req.activityPurpose ?? 'runtime',
        project: process.cwd(),
        route,
        model: req.model ?? model,
      };
      // Serialized only when it is going to be recorded. A disabled logger
      // must not pay to build evidence on every judgment it observes.
      const request = logContent
        ? recordedContent(
            { state: req.state, questions: req.questions, model: base.model },
            secrets,
          )
        : undefined;
      try {
        const result = await client.systemOne(req, signal);
        // Only bounded option identifiers and numeric judgments, never criteria/state/legend.
        const answers: Record<string, number | string> = {};
        for (const [id, answer] of Object.entries(result.answers).slice(0, 32)) {
          if (!/^[\w.-]{1,80}$/.test(id)) continue;
          if (answer.type === 'noul') answers[id] = answer.noul;
          else if (answer.type === 'score') answers[id] = answer.score;
          else answers[id] = /^[\w.-]{1,80}$/.test(answer.choice) ? answer.choice : '[choice]';
        }
        const incomplete = Object.keys(req.questions).some((id) => !result.answers[id]);
        recordJevActivity({
          ...base,
          model: result.model ?? base.model,
          durationMs: Date.now() - start,
          outcome: incomplete ? 'incomplete' : 'answered',
          ...(incomplete ? { reason: 'missing_or_malformed_answers' } : {}),
          ...result.usage,
          answers,
          ...(request === undefined ? {} : { request, response: recordedContent(result, secrets) }),
        });
        return result;
      } catch (error) {
        const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
        const reason =
          cause instanceof Error && ['AbortError', 'TimeoutError'].includes(cause.name)
            ? cause.name
            : error instanceof FetchError
              ? error.status === 0
                ? 'network_error'
                : error.status < 400
                  ? 'invalid_response_body'
                  : `HTTP ${error.status}`
              : error instanceof Error &&
                  [
                    'TypeSafeRestingError',
                    'TypeSafeDisabledError',
                    'AbortError',
                    'TimeoutError',
                  ].includes(error.name)
                ? error.name
                : 'transport_or_response_error';
        recordJevActivity({
          ...base,
          durationMs: Date.now() - start,
          outcome: 'fallback',
          reason,
          ...(request === undefined
            ? {}
            : { request, error: recordedContent(describeError(error, cause), secrets) }),
        });
        throw error;
      }
    },
  };
}

/** The failure as a reader of the log wants it: what failed, and with what. */
function describeError(error: unknown, cause: unknown): unknown {
  if (!(error instanceof Error)) return { name: 'NonError', message: String(error) };
  return {
    name: error.name,
    message: error.message,
    ...(error instanceof FetchError ? { status: error.status } : {}),
    // A transport failure is a wrapper around the socket's own error, and the
    // wrapper's message says "network error" where the real cause says why.
    ...(cause instanceof Error && cause !== error
      ? { cause: { name: cause.name, message: cause.message } }
      : {}),
  };
}
