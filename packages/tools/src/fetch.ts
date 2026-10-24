import type { Tool, ToolStreamEvent } from '@wrongstack/contracts/types';
import {
  activeLimits,
  FetchError,
  positiveLimit,
  TOOL_MEMORY_GUARD_BYTES,
  ToolError,
  ToolValidationError,
} from '@wrongstack/contracts/types';
import { ALLOW_PRIVATE, assertNotPrivate, guardedFetch } from './_fetch-guard.js';
import { getTurndown } from './_turndown.js';
import { capBytesWithNotice } from './_util.js';
import { browserPrivateOrigins } from './browser/policy.js';
import { isPrivateOriginApproved, networkAllowHint } from './browser/security.js';

export type FetchFormat = 'markdown' | 'text' | 'raw';

export interface FetchInput {
  url: string;
  format?: FetchFormat | undefined;
}

export interface FetchOutput {
  content: string;
  status: number;
  content_type: string;
  url: string;
}

/**
 * RAM guard against an endless or enormous body — NOT a context budget. The
 * whole page is returned; a large result reaches the model through the tool
 * executor's lossless spool (file + preview), so nothing is cut to fit.
 */
const MAX_DOWNLOAD_BYTES = TOOL_MEMORY_GUARD_BYTES;
const TIMEOUT_MS = 20_000;

/**
 * The page as returned to the model: whole, unless the user set
 * `limits.fetchBytes` (then cut at that many bytes, and said so). The cut
 * notice is paid for out of the cap, so the result never exceeds it.
 */
function capFetchedContent(content: string, stoppedAtGuard: boolean, received: number): string {
  const userCap = positiveLimit(activeLimits().fetchBytes);
  const guardNotice = stoppedAtGuard
    ? `[download stopped at ${received} bytes: memory guard]`
    : undefined;
  if (userCap === undefined) return guardNotice ? `${content}\n\n${guardNotice}` : content;
  const cutNotice = `[cut at ${userCap} bytes by limits.fetchBytes]`;
  return capBytesWithNotice(
    content,
    userCap,
    guardNotice ? `${cutNotice}\n\n${guardNotice}` : cutNotice,
  );
}

/** Abort when any of the signals abort (Node 22+ — AbortSignal.any shipped in Node 20). */
const combineSignals = (signals: AbortSignal[]): AbortSignal => AbortSignal.any(signals);

// SSRF guard machinery (guardedLookup, the pinned undici dispatcher,
// guardedFetch, assertNotPrivate) lives in _fetch-guard.ts so the `search`
// entry can use guardedFetch without bundling the whole fetch tool.
// Re-exported here to keep this module's historical public API intact.
export { guardedFetch, guardedLookup } from './_fetch-guard.js';

export const fetchTool: Tool<FetchInput, FetchOutput> = {
  name: 'fetch',
  category: 'Network',
  description:
    'Fetch a URL and return its content. HTML pages are automatically converted to clean markdown. ' +
    'This tool has strong SSRF protections (private IPs, localhost, and cloud metadata endpoints are blocked by default).',
  usageHint:
    'Use this when you need external information (documentation, API responses, web pages, etc.).\n\n' +
    'Security notes:\n' +
    '- Only HTTPS is allowed by default.\n' +
    '- Internal/private networks are blocked unless explicitly enabled via environment variable.\n' +
    '- Redirects are followed but re-validated at each hop.\n' +
    '- Output is capped (128KB by default) to avoid flooding context.\n' +
    'Prefer this over raw `bash curl` or `bash wget`.',
  // H-9 (AT-02): `fetch` was `permission:'auto'` with `mutating:false`, so
  // the `tool.permission === 'auto' && !isMutating` branch at
  // `permission-policy.ts:408-424` returned `{permission:'auto'}` for
  // every call, in every mode (YOLO or not) — a complete, prompt-free
  // exfiltration primitive when chained with the equally-unprompted
  // `read` of `.env`/`~/.ssh/*` (sensitive-read gate is `!effectiveYolo`
  // and therefore also skipped under the shipped default). Promoting to
  // `permission:'confirm'` is the narrowest change that closes the
  // exfiltration path: it prompts the user, and an "always" answer is
  // persisted to `trust.json` against the URL subject declared below.
  // The SSRF guard (`guardedFetch`) still constrains where the request
  // can land; this change just ensures the *whether* is no longer silent.
  permission: 'confirm',
  mutating: false,
  capabilities: ['net.outbound'],
  icon: 'web',
  // Trust rules for fetch match on the literal URL — declare it explicitly
  // so a user can trust `https://api.example.com/*` without accidentally
  // matching that pattern on any other tool that happens to have a `url`
  // input field.
  subjectKey: 'url',
  timeoutMs: TIMEOUT_MS,
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The target URL (must use https://).',
      },
      format: {
        type: 'string',
        enum: ['markdown', 'text', 'raw'],
        description:
          'Output format. "markdown" (default for HTML) converts HTML to Markdown; "text" strips HTML to plain text; "raw" returns the body unmodified. JSON is pretty-printed except in raw.',
      },
    },
    required: ['url'],
  },
  async execute(input, ctx, opts) {
    let final: FetchOutput | undefined;
    const executeStream = fetchTool.executeStream;
    if (!executeStream) {
      throw new ToolError({
        message: 'fetchTool: stream execution unavailable',
        code: 'TOOL_EXECUTION_FAILED',
        toolName: 'fetch',
      });
    }
    for await (const ev of executeStream(input, ctx, opts)) {
      if (ev.type === 'final') final = ev.output;
    }
    if (!final) {
      throw new ToolError({
        message: 'fetch: stream ended without final event',
        code: 'TOOL_EXECUTION_FAILED',
        toolName: 'fetch',
      });
    }
    return final;
  },
  async *executeStream(input, ctx, opts): AsyncGenerator<ToolStreamEvent<FetchOutput>> {
    if (!input?.url || typeof input.url !== 'string' || !input.url.trim()) {
      throw new ToolValidationError({
        message: 'fetch: url is required and cannot be empty',
        field: 'url',
      });
    }

    const trimmedUrl = input.url.trim();
    const allowedPrivateOrigins = browserPrivateOrigins(
      ctx.projectRoot ?? ctx.cwd ?? process.cwd(),
    );
    let u: URL;
    try {
      u = new URL(trimmedUrl);
    } catch {
      throw new ToolValidationError({
        message: `fetch: invalid URL "${input.url}"`,
        field: 'url',
      });
    }

    const ALLOWED_FORMATS = new Set(['markdown', 'text', 'raw']);
    if (input.format !== undefined && !ALLOWED_FORMATS.has(input.format)) {
      throw new ToolValidationError({
        message: `fetch: unsupported format "${input.format}". Allowed formats: markdown, text, raw`,
        field: 'format',
      });
    }

    if (u.username || u.password) {
      // Credentials embedded in URLs leak into logs, session transcripts, and
      // redirect targets; reject them outright instead of forwarding secrets.
      throw new ToolValidationError({
        message: 'fetch: URLs with embedded credentials (user:pass@host) are not allowed',
        field: 'url',
      });
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') {
      throw new ToolValidationError({
        message: `fetch: unsupported protocol "${u.protocol}"`,
        field: 'url',
      });
    }
    const approvedOrigin = isPrivateOriginApproved(u, allowedPrivateOrigins);
    if (u.protocol === 'http:' && !ALLOW_PRIVATE && !approvedOrigin) {
      throw new ToolValidationError({
        message: `fetch: http:// blocked (HTTPS required by default). ${networkAllowHint(u)}`,
        field: 'url',
      });
    }
    if (!approvedOrigin)
      await assertNotPrivate(u.hostname).catch((error: unknown) => {
        if (error instanceof Error)
          throw new ToolValidationError({
            message: `${error.message}. ${networkAllowHint(u)}`,
            field: 'url',
          });
        throw error;
      });

    yield { type: 'log', text: `GET ${trimmedUrl}` };

    const signal = opts?.signal ?? ctx.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const ctrl = new AbortController();
    const timer = setTimeout(
      () =>
        ctrl.abort(
          new ToolError({
            message: 'fetch timeout',
            code: 'TOOL_TIMEOUT',
            toolName: 'fetch',
          }),
        ),
      TIMEOUT_MS,
    );
    const combined = combineSignals([signal, ctrl.signal]);

    try {
      let res: Response;
      try {
        res = await guardedFetch(trimmedUrl, 5, combined, undefined, { allowedPrivateOrigins });
      } catch (err) {
        // A user-initiated cancel propagates unchanged. Our own timeout and any
        // transport failure get a diagnostic message: undici throws an opaque
        // `TypeError: fetch failed` whose real reason (ENOTFOUND, ECONNREFUSED,
        // UND_ERR_CONNECT_TIMEOUT, a TLS/cert error, …) lives only on `.cause`.
        // Surfacing just `.message` left users with "fetch failed" and no clue
        // why HTTPS broke (see #100), so unwrap the cause chain here.
        if (signal.aborted) throw err;
        throw describeFetchError(err, trimmedUrl, ctrl.signal.aborted);
      }

      // A body-less response (204 No Content, 205, 304, or an explicit zero
      // length) usually has no content-type; defaulting it to octet-stream
      // refused a successful empty response as "binary".
      const bodyless =
        res.status === 204 ||
        res.status === 205 ||
        res.status === 304 ||
        res.headers.get('content-length') === '0';
      const ct =
        res.headers.get('content-type') ?? (bodyless ? 'text/plain' : 'application/octet-stream');
      const normalizedType = ct.toLowerCase();
      if (/^image\/|^audio\/|^video\/|application\/octet-stream/.test(normalizedType)) {
        throw new FetchError({
          message: `fetch: refusing to read binary content-type "${ct}"`,
          status: res.status,
          context: { url: res.url, contentType: ct },
        });
      }

      yield {
        type: 'log',
        text: `HTTP ${res.status} ${ct}`,
        data: { status: res.status, contentType: ct },
      };

      const reader = res.body?.getReader();
      let received = 0;
      let stoppedAtGuard = false;
      const chunks: Uint8Array[] = [];
      let pendingBytes = 0;
      const FLUSH_AT = 4 * 1024;
      if (reader) {
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;
            received += value.byteLength;
            pendingBytes += value.byteLength;
            chunks.push(value);
            if (pendingBytes >= FLUSH_AT) {
              // Snapshot recent bytes for the partial_output. Keep it cheap —
              // don't try to decode UTF-8 boundaries; the TUI just needs a
              // "things are happening" signal.
              const recent = Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString(
                'utf8',
              );
              yield {
                type: 'partial_output',
                text: recent,
                data: { received },
              };
              pendingBytes = 0;
            }
            if (received > MAX_DOWNLOAD_BYTES) {
              stoppedAtGuard = true;
              await reader.cancel().catch(() => {});
              break;
            }
          }
        } finally {
          reader.releaseLock();
        }
      }
      const text = Buffer.concat(chunks).toString('utf8');

      const isHtml = normalizedType.includes('text/html');
      const isJson = /[/+]json(;|$)/i.test(ct);
      const format = input.format ?? (isHtml ? 'markdown' : 'text');
      let content: string;
      if (format === 'raw') content = text;
      else if (format === 'markdown' && isHtml) content = (await getTurndown()).turndown(text);
      else if (format === 'markdown' && isJson) content = `\`\`\`json\n${prettyJson(text)}\n\`\`\``;
      else if (isHtml) content = htmlToPlainText(text);
      else if (isJson) content = prettyJson(text);
      else content = text;

      yield {
        type: 'final',
        output: {
          content: capFetchedContent(content, stoppedAtGuard, received),
          status: res.status,
          content_type: ct,
          url: res.url,
        },
      };
      // P2 #5: record the network request as a structured side effect.
      ctx.recordSideEffect?.({
        toolUseId: `fetch-${Date.now()}`,
        toolName: 'fetch',
        ts: new Date().toISOString(),
        input: { url: input.url, format: input.format },
        outcome: `HTTP ${res.status} (${ct})`,
        risk: 'network',
      });
    } finally {
      clearTimeout(timer);
      // Rejection and generator.return() may leave the response unread. Stop
      // the transport even when the caller abandons at the HTTP-header yield,
      // before a body reader exists, or while partial output is being yielded.
      ctrl.abort();
    }
  },
};

/**
 * Turn an opaque undici `TypeError: fetch failed` into an actionable message by
 * walking its `.cause` chain. undici buries the transport reason (a DNS/socket
 * errno or a TLS handshake failure) one or more `.cause` hops down, so the bare
 * `.message` is always just "fetch failed". We join each distinct
 * `code: message` link so the user sees, e.g.,
 * `fetch: GET https://x failed — UND_ERR_CONNECT_TIMEOUT: Connect Timeout Error`.
 */
function describeFetchError(err: unknown, url: string, timedOut: boolean): FetchError | ToolError {
  if (timedOut) {
    return new ToolError({
      message: `fetch: GET ${url} timed out after ${TIMEOUT_MS}ms`,
      code: 'TOOL_TIMEOUT',
      toolName: 'fetch',
      context: { url, timedOut: true, timeoutMs: TIMEOUT_MS },
      cause: err,
    });
  }
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur instanceof Error && !seen.has(cur)) {
    seen.add(cur);
    const code = (cur as NodeJS.ErrnoException).code;
    const label = code ? `${code}: ${cur.message}` : cur.message;
    // Skip undici's uninformative top-level "fetch failed" wrapper, but keep it
    // as a fallback if it turns out to be the only thing we have.
    if (label && label !== 'fetch failed' && !parts.includes(label)) parts.push(label);
    cur = (cur as { cause?: unknown }).cause;
  }
  const detail = parts.length > 0 ? parts.join(' → ') : 'fetch failed';
  return new FetchError({
    message: `fetch: GET ${url} failed — ${detail}`,
    status: 502,
    context: { url, timedOut: false, transportErrors: parts },
    // Preserve the original undici / DNS / TLS chain so callers can inspect
    // it via `err.cause` and structured `instanceof` checks. The flattened
    // text version stays in the message for human readability.
    cause: err,
  });
}

/**
 * `format: "text"` on an HTML page used to return the markup unchanged —
 * identical to `raw`, scripts included. Drop non-content elements, keep block
 * boundaries as line breaks, and decode the common entities.
 */
function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/pre)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function prettyJson(s: string): string {
  if (!s || s.length > 500_000) return s;
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
