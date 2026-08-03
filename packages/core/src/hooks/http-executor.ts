import type { AnyHookOutcome, HookInput } from '../types/hooks.js';
import type { Logger } from '../types/logger.js';
import { assertNotPrivateHost } from '../utils/ip-guard.js';
import {
  type HookExecutionOptions,
  type HookExecutionResult,
  parseHookOutcome,
} from './shell-executor.js';

const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export interface HttpHookSpec {
  url: string;
  headers?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Validate a hook URL: block private/internal IPs (SSRF), non-HTTP
 * protocols, and non-loopback HTTP (hook executor is for local dev).
 */
async function isAllowedUrl(raw: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') {
    // SSRF guard: block private IPs even for HTTPS
    try {
      await assertNotPrivateHost(url.hostname);
      return true;
    } catch {
      return false;
    }
  }
  if (url.protocol !== 'http:') return false;
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

/** POST HookInput JSON to a native HTTP hook with deadline and cancellation. */
export async function runHttpHookDetailed(
  spec: HttpHookSpec,
  input: HookInput,
  logger?: Logger | undefined,
  options: HookExecutionOptions = {},
): Promise<HookExecutionResult> {
  if (!(await isAllowedUrl(spec.url))) {
    return {
      outcome: null,
      failure: {
        kind: 'rejected',
        message: 'HTTP hooks require HTTPS, except for loopback HTTP endpoints',
      },
    };
  }

  const timeoutMs = Math.max(1, Math.min(spec.timeoutMs ?? DEFAULT_TIMEOUT_MS, 10 * 60_000));
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error('hook timeout')), timeoutMs);
  timer.unref?.();
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const response = await fetch(spec.url, {
      method: 'POST',
      headers: { ...(spec.headers ?? {}), 'content-type': 'application/json' },
      body: JSON.stringify(input),
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      return {
        outcome: null,
        failure: { kind: 'error', message: `HTTP hook returned ${response.status}` },
      };
    }

    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_OUTPUT_BYTES) {
      return {
        outcome: null,
        failure: { kind: 'invalid_output', message: 'HTTP hook response exceeded 64 KiB' },
      };
    }
    if (!text.trim()) return { outcome: null };
    const outcome: AnyHookOutcome | null = parseHookOutcome(text);
    return outcome
      ? { outcome }
      : {
          outcome: null,
          failure: {
            kind: 'invalid_output',
            message: 'HTTP hook response was not valid outcome JSON',
          },
        };
  } catch (err) {
    const timedOut = timeoutController.signal.aborted && !options.signal?.aborted;
    const kind = timedOut ? 'timeout' : options.signal?.aborted ? 'aborted' : 'error';
    const message = timedOut
      ? `timed out after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    logger?.warn?.(`HTTP hook failed: ${message}`);
    return { outcome: null, failure: { kind, message } };
  } finally {
    clearTimeout(timer);
  }
}
