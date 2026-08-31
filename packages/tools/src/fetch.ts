import type { Tool, ToolStreamEvent } from '@wrongstack/core/types';
import { FetchError, ToolError, ToolValidationError } from '@wrongstack/core/types';
import TurndownService from 'turndown';
import { ALLOW_PRIVATE, assertNotPrivate, guardedFetch } from './_fetch-guard.js';
import { truncateMiddle } from './_util.js';

/**
 * Singleton Turndown instance for HTML→Markdown conversion.
 * Pre-configured with sensible defaults; code blocks are handled via the
 * default fenced code rule. Reused across all fetch calls.
 */
const TD = new TurndownService({
  // Use `# Title` for headings, not setext underline style (`Title\n=====`).
  headingStyle: 'atx',
  // Don't wrap code blocks in <pre> — render them as triple-backtick blocks.
  codeBlockStyle: 'fenced',
});

// Strip <script>/<style>/<noscript> before turndown sees them. The old
// hand-rolled converter did this via regex; turndown's DOM-based approach
// may keep their text content unless we remove the elements first.
// Using turndown's own addRule mechanism keeps the logic co-located.
TD.addRule('stripDangerousElements', {
  filter: ['script', 'style', 'noscript'],
  replacement: () => '',
});

// Prune boilerplate chrome before conversion: navigation menus, page
// headers/footers, sidebars, inline SVG markup, and iframes carry almost no
// information for the agent but routinely dominate the converted markdown of
// real-world pages. Removing the elements (not just their tags) is the single
// biggest token win for the fetch tool. A filter function (rather than a tag
// list) keeps the match case-insensitive — SVG elements keep lowercase
// nodeNames while HTML elements report uppercase.
const PRUNED_BOILERPLATE_TAGS = new Set(['nav', 'header', 'footer', 'aside', 'svg', 'iframe']);
TD.remove((node) => PRUNED_BOILERPLATE_TAGS.has(node.nodeName.toLowerCase()));

interface FetchInput {
  url: string;
  format?: 'markdown' | 'text' | 'raw' | undefined;
}

interface FetchOutput {
  content: string;
  status: number;
  content_type: string;
  url: string;
}

const MAX_BYTES = 131_072;
const TIMEOUT_MS = 20_000;

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
  permission: 'auto',
  mutating: false,
  capabilities: ['net.outbound'],
  icon: 'web',
  // Trust rules for fetch match on the literal URL — declare it explicitly
  // so a user can trust `https://api.example.com/*` without accidentally
  // matching that pattern on any other tool that happens to have a `url`
  // input field.
  subjectKey: 'url',
  timeoutMs: TIMEOUT_MS,
  maxOutputBytes: MAX_BYTES,
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
          'Output format. "markdown" is recommended for HTML pages; for non-HTML content types it falls back to plain text (JSON is pretty-printed).',
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
    if (!input?.url) {
      throw new ToolValidationError({
        message: 'fetch: url is required',
        field: 'url',
      });
    }
    const u = new URL(input.url);
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
    if (u.protocol === 'http:' && !ALLOW_PRIVATE) {
      throw new ToolValidationError({
        message: 'fetch: http:// blocked (HTTPS required by default)',
        field: 'url',
      });
    }
    await assertNotPrivate(u.hostname);

    yield { type: 'log', text: `GET ${input.url}` };

    const signal = opts?.signal ?? ctx.signal ?? new AbortController().signal;
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
        res = await guardedFetch(input.url, 5, combined);
      } catch (err) {
        // A user-initiated cancel propagates unchanged. Our own timeout and any
        // transport failure get a diagnostic message: undici throws an opaque
        // `TypeError: fetch failed` whose real reason (ENOTFOUND, ECONNREFUSED,
        // UND_ERR_CONNECT_TIMEOUT, a TLS/cert error, …) lives only on `.cause`.
        // Surfacing just `.message` left users with "fetch failed" and no clue
        // why HTTPS broke (see #100), so unwrap the cause chain here.
        if (signal.aborted) throw err;
        throw describeFetchError(err, input.url, ctrl.signal.aborted);
      }

      const ct = res.headers.get('content-type') ?? 'application/octet-stream';
      if (/^image\/|^audio\/|^video\/|application\/octet-stream/.test(ct)) {
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
      const chunks: Uint8Array[] = [];
      let pendingBytes = 0;
      const FLUSH_AT = 4 * 1024;
      if (reader) {
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
            const recent = Buffer.from(value).toString('utf-8');
            yield {
              type: 'partial_output',
              text: recent,
              data: { received },
            };
            pendingBytes = 0;
          }
          if (received > MAX_BYTES) break;
        }
      }
      const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');

      const format = input.format ?? (ct.includes('text/html') ? 'markdown' : 'text');
      let content: string;
      if (format === 'raw') content = text;
      else if (format === 'markdown' && ct.includes('text/html')) content = TD.turndown(text);
      else if (ct.includes('application/json')) content = prettyJson(text);
      else content = text;

      yield {
        type: 'final',
        output: {
          content: truncateMiddle(content, MAX_BYTES),
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

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}
