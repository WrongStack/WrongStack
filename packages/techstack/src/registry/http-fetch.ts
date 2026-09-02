/** Shared dependency-service HTTP transport with cancellation and bounded retry. */

import { get as httpGet, request as httpRequest } from 'node:http';
import type { IncomingHttpHeaders, IncomingMessage, RequestOptions } from 'node:http';
import { get as httpsGet, request as httpsRequest } from 'node:https';

export interface HttpResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface HttpRequestOptions {
  readonly hostname: string;
  readonly path: string;
  readonly method?: 'GET' | 'POST' | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly body?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
  readonly baseBackoffMs?: number | undefined;
  /** Hard cap on the response body length; default 64 MiB. Guards against a
   * misbehaving or hostile registry streaming an unbounded body into memory. */
  readonly maxBodyBytes?: number | undefined;
}

/** Default response-body ceiling. Registry metadata for popular packages can be
 * several MB, so the cap is generous while still bounding host memory. */
const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;

export function retryAfterMs(headers: IncomingHttpHeaders, now = Date.now()): number | undefined {
  const value = Array.isArray(headers['retry-after'])
    ? headers['retry-after'][0]
    : headers['retry-after'];
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new DOMException('Request aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('Request aborted', 'AbortError'));
    };
    // Remove the abort listener on normal completion, not only via { once }
    // on the abort path. requestWithRetry calls delay() repeatedly with the
    // SAME signal, so without this a retrying request leaks one abort listener
    // per retry on a reused/long-lived signal (MaxListenersExceededWarning).
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function requestOnce(options: HttpRequestOptions): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const method = options.method ?? 'GET';
    const requestOptions: RequestOptions = {
      hostname: options.hostname,
      path: options.path,
      method,
      headers: options.headers,
      signal: options.signal,
      timeout: options.timeoutMs ?? 15_000,
    };
    const isHttp = options.hostname === 'localhost' || options.hostname === '127.0.0.1';
    const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    const callback = (response: IncomingMessage): void => {
      let body = '';
      response.setEncoding?.('utf8');
      response.on('data', (chunk: string | Buffer) => {
        body += chunk.toString();
        if (body.length > maxBodyBytes) {
          // Stop reading and fail loudly rather than growing the buffer without
          // bound (also defeats a slow-drip stream that never trips the idle
          // timeout). destroy() ends the socket; the retry loop treats it as a
          // transport error.
          response.destroy();
          reject(
            new Error(
              `Response body exceeded ${maxBodyBytes} bytes for ${options.hostname}${options.path}`,
            ),
          );
        }
      });
      response.on('end', () =>
        resolve({
          statusCode: response.statusCode ?? 0,
          headers: response.headers,
          body,
        }),
      );
    };
    const request =
      method === 'GET'
        ? (isHttp ? httpGet : httpsGet)(requestOptions, callback)
        : (isHttp ? httpRequest : httpsRequest)(requestOptions, callback);
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error(`Request timeout for ${options.hostname}${options.path}`));
    });
    if (options.body) request.write(options.body);
    request.end();
  });
}

export async function requestWithRetry(options: HttpRequestOptions): Promise<HttpResponse> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const response = await requestOnce(options);
      const retryable = response.statusCode === 429 || response.statusCode >= 500;
      if (!retryable || attempt === maxAttempts - 1) return response;
      const serverDelay = retryAfterMs(response.headers);
      const exponential = (options.baseBackoffMs ?? 1_000) * 2 ** attempt;
      await delay(serverDelay ?? exponential, options.signal);
    } catch (error) {
      if (options.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError'))
        throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < maxAttempts - 1) {
        await delay((options.baseBackoffMs ?? 1_000) * 2 ** attempt, options.signal);
      }
    }
  }
  throw lastError ?? new Error(`Request failed for ${options.hostname}${options.path}`);
}

export function parseJsonResponse<T>(response: HttpResponse, source: string): T {
  try {
    return JSON.parse(response.body) as T;
  } catch {
    throw new Error(`Invalid JSON response from ${source}`);
  }
}
