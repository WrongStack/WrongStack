/**
 * Local-LLM health probe — `GET <baseUrl>/v1/models`.
 *
 * This module lives in `@wrongstack/runtime` (not `@wrongstack/cli` or
 * `@wrongstack/providers`) so the WebUI server can reuse it without
 * pulling in the entire CLI dependency graph. The function is
 * identical to the one in `@wrongstack/cli/src/auth-menu/local.ts` —
 * we keep a single canonical implementation here and have the CLI
 * re-export from this one.
 *
 * The probe:
 *   - Hits `GET <baseUrl>/models` (OpenAI-compatible)
 *   - Sends an optional `Authorization: Bearer <key>` header
 *   - Scrubs every result through the `SecretScrubber` so a Bearer
 *     token accidentally captured in an error page never reaches
 *     the renderer
 *   - Returns a `ProbeResult` (never throws) so the caller can
 *     decide how to react to each `status`
 */
import type { SecretScrubber } from '@wrongstack/core/types';

/** Default probe timeout. Local servers should respond in < 100ms. */
const PROBE_TIMEOUT_MS = 3_000;

export interface ProbeOptions {
  baseUrl: string;
  apiKey: string | undefined;
  noAuth: boolean;
  /**
   * Display label for the probed server — the CLI uses this in the
   * rendered probe result ("Ollama health probe ok"). Optional; the
   * probe itself doesn't care.
   */
  presetLabel?: string | undefined;
  /** Used to scrub error-page bodies and network error messages. */
  scrubber: SecretScrubber;
  fetchImpl?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

export interface ProbeResult {
  ok: boolean;
  status:
    | 'ok'
    | 'unreachable'
    | 'timeout'
    | 'http_error'
    | 'invalid_response'
    | 'skipped'
    | 'no_provider'
    | 'no_base_url';
  httpStatus?: number | undefined;
  elapsedMs?: number | undefined;
  modelCount?: number | undefined;
  /**
   * The actual model ids returned by the server, deduplicated, in
   * server-reported order. Empty (not undefined) when the server
   * returned a valid empty list.
   */
  modelIds?: string[] | undefined;
  /** Redactable error detail (e.g. ECONNREFUSED). */
  detail?: string | undefined;
}

/**
 * Probe a local LLM server by hitting the OpenAI-compatible
 * `GET /v1/models` endpoint.
 *
 * The probe is fully isolated from the config layer — it only
 * returns a `ProbeResult` and never throws.
 */
export async function probeLocalLlm(opts: ProbeOptions): Promise<ProbeResult> {
  const { baseUrl, apiKey, noAuth, scrubber, fetchImpl, timeoutMs } = opts;
  const fetchFn = fetchImpl ?? fetch;
  const timeout = timeoutMs ?? PROBE_TIMEOUT_MS;

  if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
    return { ok: false, status: 'no_base_url', detail: 'baseUrl is empty' };
  }

  // Normalize the URL: append `/models` if the user gave us the chat
  // completions base. Strip trailing slashes so we can just concatenate.
  const base = baseUrl.trim().replace(/\/+$/, '');
  const url = /\/models$/.test(base) ? base : `${base}/models`;

  const headers: Record<string, string> = { accept: 'application/json' };
  if (!noAuth && apiKey) {
    headers['authorization'] = `Bearer ${apiKey}`;
  }

  const started = Date.now();
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    const elapsed = Date.now() - started;
    const name = (err as { name?: string } | null)?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      return { ok: false, status: 'timeout', elapsedMs: elapsed, detail: `> ${timeout}ms` };
    }
    const detail = scrubber.scrub((err as Error)?.message ?? String(err));
    return { ok: false, status: 'unreachable', elapsedMs: elapsed, detail };
  }

  const elapsed = Date.now() - started;

  if (!res.ok) {
    let bodySlice = '';
    try {
      const txt = await res.text();
      bodySlice = txt.slice(0, 200);
    } catch {
      // ignore
    }
    return {
      ok: false,
      status: 'http_error',
      httpStatus: res.status,
      elapsedMs: elapsed,
      detail: scrubber.scrub(bodySlice) || undefined,
    };
  }

  const modelIds: string[] = [];
  try {
    const parsed = (await res.json()) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return {
        ok: false,
        status: 'invalid_response',
        httpStatus: res.status,
        elapsedMs: elapsed,
        detail: 'response is not a JSON object',
      };
    }
    const obj = parsed as Record<string, unknown>;
    const dataList = obj['data'];
    const modelsList = obj['models'];
    const rawList: unknown[] | null = Array.isArray(dataList)
      ? (dataList as unknown[])
      : Array.isArray(modelsList)
        ? (modelsList as unknown[])
        : null;
    if (rawList === null) {
      return {
        ok: false,
        status: 'invalid_response',
        httpStatus: res.status,
        elapsedMs: elapsed,
        detail: 'no `data` or `models` array in response',
      };
    }
    const seen = new Set<string>();
    for (const entry of rawList) {
      if (!entry || typeof entry !== 'object') continue;
      const e = entry as Record<string, unknown>;
      const raw =
        typeof e['id'] === 'string' ? e['id'] : typeof e['name'] === 'string' ? e['name'] : null;
      if (raw === null) continue;
      const id = scrubber.scrub(raw).trim();
      if (id.length === 0) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      modelIds.push(id);
    }
  } catch (err) {
    return {
      ok: false,
      status: 'invalid_response',
      httpStatus: res.status,
      elapsedMs: elapsed,
      detail: scrubber.scrub((err as Error)?.message ?? 'parse failed'),
    };
  }

  return {
    ok: true,
    status: 'ok',
    httpStatus: res.status,
    elapsedMs: elapsed,
    modelCount: modelIds.length,
    modelIds,
  };
}
