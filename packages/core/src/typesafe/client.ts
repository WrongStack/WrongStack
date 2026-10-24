/**
 * Minimal HTTP client for the TypeSafe System One evaluation endpoint.
 *
 * `POST https://api.typesafe.ai/v1/systemone` takes a `state` (our JSON) plus a
 * map of typed `questions` and returns one typed `answer` per question id. The
 * questions are declarative — Choice picks one option from a set we define,
 * Noul returns the probability a yes/no condition holds, Score returns a
 * position across ordered levels we describe — so the answers are data our own
 * code branches on rather than text to parse.
 *
 * This module is subsystem-agnostic: the skill suggester and the agent
 * dispatcher both talk to the same endpoint with different questions, so the
 * transport lives here rather than inside either one.
 *
 * Why not `@typesafe-ai/sdk`: the whole surface we use is one POST with a JSON
 * body. Taking the dependency would put a package on core's import graph for
 * a feature that is OFF by default, and core's cold start is a measured budget
 * (see the eager-dependency work that pulled `undici` and `turndown` back out
 * of the barrel). ~150 lines of `fetch` costs nothing when the feature is
 * disabled, which is the common case.
 *
 * The response is treated as an untrusted third-party payload: every field is
 * validated before it reaches a caller, and a malformed body degrades to
 * `undefined` answers rather than throwing shapes at the suggester.
 */

import { FetchError } from '@wrongstack/contracts/types/errors';
import type {
  ChoiceAnswer,
  ChoiceQuestion,
  NoulAnswer,
  NoulQuestion,
  ScoreAnswer,
  ScoreQuestion,
  SystemOneRequest,
  SystemOneResult,
  TypeSafeAnswer,
  TypeSafeQuestion,
} from '@wrongstack/contracts/types/typesafe';
import { toErrorMessage } from '../utils/error.js';
import { TYPESAFE_ROUTES } from './route.js';

/**
 * Default evaluation endpoint — the native TypeSafe route.
 *
 * Sourced from the route table rather than repeated, so the two places that
 * know this URL cannot disagree. `resolve.ts` picks a route; a client built
 * without one falls back to the native host.
 */
export const DEFAULT_TYPESAFE_ENDPOINT = TYPESAFE_ROUTES.typesafe.url;

/** Default model alias. `jev-latest` tracks TypeSafe's flagship System One model. */
export const DEFAULT_TYPESAFE_MODEL = TYPESAFE_ROUTES.typesafe.model;

/** Statuses the API documents as transient and worth retrying. */
const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504, 529]);

export type {
  ChoiceAnswer,
  ChoiceQuestion,
  NoulAnswer,
  NoulQuestion,
  ScoreAnswer,
  ScoreQuestion,
  SystemOneRequest,
  SystemOneResult,
  TypeSafeAnswer,
  TypeSafeQuestion,
};

export interface TypeSafeClient {
  systemOne(req: SystemOneRequest, signal?: AbortSignal): Promise<SystemOneResult>;
}

export interface TypeSafeClientOptions {
  apiKey: string;
  /** Override for self-hosted / proxied deployments. */
  endpoint?: string | undefined;
  model?: string | undefined;
  /** Per-attempt timeout. Default 4000ms. */
  timeoutMs?: number | undefined;
  /** Total attempts including the first. Default 2. */
  maxAttempts?: number | undefined;
  /** Injectable transport; defaults to global `fetch`. Tests pass a stub. */
  fetchImpl?: typeof fetch | undefined;
  /**
   * Called once per SUCCESSFUL response with what it cost.
   *
   * Every feature here bills per turn, and until this existed the numbers left
   * the process unread: the result carried `usage` and both consumers dropped
   * it. Never throws into a caller — an accounting sink must not be able to
   * fail the judgment it is accounting for.
   */
  onUsage?: ((usage: TypeSafeUsage) => void) | undefined;
}

export interface TypeSafeUsage {
  inputTokens: number;
  outputTokens: number;
  /** The model the service reported, when it reported one. */
  model: string | undefined;
  /** The endpoint the request went to, for per-route accounting. */
  endpoint: string;
}

export function createTypeSafeClient(opts: TypeSafeClientOptions): TypeSafeClient {
  const endpoint = opts.endpoint?.trim() || DEFAULT_TYPESAFE_ENDPOINT;
  const model = opts.model?.trim() || DEFAULT_TYPESAFE_MODEL;
  // The value can come from a hand-edited config file. Node clamps a timer over
  // 2^31-1 ms to 1 ms and rejects one of 2^32 or more outright, which failed
  // every call; keep it a usable timer delay.
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? Math.min(opts.timeoutMs, 2_147_483_647)
      : 4_000;
  const maxAttempts = Math.max(1, opts.maxAttempts ?? 2);
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    async systemOne(req, signal) {
      const body = JSON.stringify({
        state: req.state,
        model: req.model?.trim() || model,
        questions: req.questions,
      });
      let lastError: unknown;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        signal?.throwIfAborted();
        if (attempt > 0) {
          // Exponential backoff, as the API reference asks for on 429/529.
          await delay(150 * 2 ** (attempt - 1), signal);
        }
        signal?.throwIfAborted();
        try {
          const result = await postOnce(doFetch, endpoint, opts.apiKey, body, timeoutMs, signal);
          try {
            opts.onUsage?.({ ...result.usage, model: result.model, endpoint });
          } catch {
            // An accounting sink must not fail the judgment it accounts for.
          }
          return result;
        } catch (err) {
          lastError = err;
          const status = err instanceof FetchError ? err.status : 0;
          // A 401/422 will fail identically on every retry; only spend a second
          // attempt on the statuses the service itself calls transient. A
          // network error (status 0) is worth one more try.
          if (status !== 0 && !RETRYABLE_STATUSES.has(status)) break;
          if (signal?.aborted) break;
        }
      }
      throw lastError;
    },
  };
}

async function postOnce(
  doFetch: typeof fetch,
  endpoint: string,
  apiKey: string,
  body: string,
  timeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<SystemOneResult> {
  // Compose the caller's cancellation with our own deadline so a hung socket
  // cannot outlive the turn it was meant to inform.
  const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
  let res: Response;
  try {
    res = await doFetch(endpoint, {
      method: 'POST',
      signal: AbortSignal.any(signals),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'wrongstack-typesafe',
      },
      body,
    });
  } catch (err) {
    throw new FetchError({
      // The key is in a header, never in `endpoint`, so echoing the URL here
      // cannot leak it.
      message: `Network error calling TypeSafe: ${toErrorMessage(err)}`,
      status: 0,
      context: { url: endpoint, op: 'typesafe.systemOne' },
      cause: err,
    });
  }
  if (!res.ok) {
    throw new FetchError({
      message: `TypeSafe returned ${res.status} ${res.statusText}`,
      status: res.status,
      context: { url: endpoint, op: 'typesafe.systemOne' },
    });
  }
  let payload: unknown;
  try {
    payload = await res.json();
  } catch (err) {
    throw new FetchError({
      message: 'TypeSafe returned a non-JSON body',
      status: res.status,
      context: { url: endpoint, op: 'typesafe.systemOne' },
      cause: err,
    });
  }
  return parseSystemOneResult(payload);
}

/**
 * Validate a response body into `SystemOneResult`.
 *
 * Exported for tests. Answers that do not match their documented shape are
 * DROPPED rather than coerced: a caller reading `answers['which']` gets
 * `undefined` and takes its own "no suggestion" path, which is always a safe
 * outcome here. Coercing a malformed answer into a plausible-looking one would
 * put a made-up probability in front of a real decision.
 */
export function parseSystemOneResult(payload: unknown): SystemOneResult {
  const root = isRecord(payload) ? payload : {};
  const rawAnswers = isRecord(root['answers']) ? root['answers'] : {};
  const answers: Record<string, TypeSafeAnswer> = {};
  for (const [id, raw] of Object.entries(rawAnswers)) {
    const answer = parseAnswer(raw);
    if (answer) answers[id] = answer;
  }
  const usage = isRecord(root['usage']) ? root['usage'] : {};
  const model = root['model'];
  return {
    answers,
    usage: {
      inputTokens: finiteOr(usage['input_tokens'], 0),
      outputTokens: finiteOr(usage['output_tokens'], 0),
    },
    model: typeof model === 'string' && model ? model : undefined,
  };
}

function parseAnswer(raw: unknown): TypeSafeAnswer | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw['type'] === 'noul') {
    const noul = raw['noul'];
    if (!isProbability(noul)) return undefined;
    return { type: 'noul', noul };
  }
  if (raw['type'] === 'choice') {
    const choice = raw['choice'];
    if (typeof choice !== 'string' || !choice) return undefined;
    const probabilities = parseProbabilities(raw['probabilities']);
    const confidence = raw['confidence'];
    if (!probabilities || !isProbability(confidence)) return undefined;
    if (!Object.hasOwn(probabilities, choice)) return undefined;
    const selected = probabilities[choice]!;
    if (Object.values(probabilities).some((value) => value > selected)) return undefined;
    return {
      type: 'choice',
      choice,
      probabilities,
      confidence,
    };
  }
  if (raw['type'] === 'score') {
    const score = raw['score'];
    if (typeof score !== 'number' || !Number.isFinite(score)) return undefined;
    // Older API examples omit score probabilities. Keep supporting that
    // shape, but never repair a malformed distribution into a valid one.
    const probabilities =
      raw['probabilities'] === undefined ? {} : parseProbabilities(raw['probabilities']);
    const confidence = raw['confidence'];
    if (!probabilities || !isProbability(confidence) || score < 0) return undefined;
    const legend: Record<string, string> = {};
    const rawLegend = isRecord(raw['legend']) ? raw['legend'] : {};
    for (const [level, text] of Object.entries(rawLegend)) {
      if (typeof text === 'string') legend[level] = text;
    }
    // `score` is NOT a probability: it is a position across the levels we
    // sent, so it is left unclamped rather than squeezed into 0..1. Callers
    // normalize against their own level count.
    return {
      type: 'score',
      score,
      probabilities,
      confidence,
      legend,
    };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function parseProbabilities(raw: unknown): Record<string, number> | undefined {
  if (!isRecord(raw)) return undefined;
  const entries = Object.entries(raw);
  if (entries.length === 0 || entries.some(([, value]) => !isProbability(value))) return undefined;
  const probabilities = Object.fromEntries(entries) as Record<string, number>;
  // Allow normal floating-point/serialized rounding, never normalize bad data.
  const total = Object.values(probabilities).reduce((sum, value) => sum + value, 0);
  return Math.abs(total - 1) <= 0.01 ? probabilities : undefined;
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    // `unref` keeps a backoff sleep from holding the process open at exit.
    (timer as unknown as { unref?: () => void }).unref?.();
    signal?.addEventListener('abort', finish, { once: true });
    if (signal?.aborted) finish();
  });
}
