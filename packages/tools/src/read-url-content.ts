import {
  activeLimits,
  positiveLimit,
  TOOL_MEMORY_GUARD_BYTES,
  type Tool,
  ToolValidationError,
} from '@wrongstack/contracts/types';
import { guardedFetch } from './_fetch-guard.js';
import { getTurndown } from './_turndown.js';
import { capBytesWithNotice } from './_util.js';
import { browserPrivateOrigins } from './browser/policy.js';

export interface ReadUrlContentInput {
  /** Target web page URL to read. */
  url?: string | undefined;
  /** Antigravity parameter alias. */
  Url?: string | undefined;
  /** Maximum bytes to return. Unset = the whole page (up to the memory guard). */
  maxBytes?: number | undefined;
}

export interface ReadUrlContentOutput {
  url: string;
  status: number;
  content_type: string;
  content: string;
}

/**
 * RAM guard on the raw body (WS-2026-09-17-02) — NOT a context budget.
 *
 * `maxBytes` is model-supplied, and the read limit derived from it is the only
 * bound on the `chunks[]` buffer, so it must never be attacker-chosen without a
 * ceiling. Unset `maxBytes` reads the whole page up to this guard: a large
 * result reaches the model through the tool executor's lossless spool (file +
 * preview), so a fixed 128KB default only threw content away.
 */
export const MAX_READ_URL_BYTES = TOOL_MEMORY_GUARD_BYTES;

/**
 * Read at most `limit` bytes of the body, then cancel the stream. `res.text()`
 * buffered the entire response before the maxBytes cut, so a multi-GB body
 * was held in memory for a 128KB answer (audit 2026-09-15). Responses without
 * a readable stream (test doubles) fall back to `text()`.
 */
async function readBounded(
  res: Response,
  limit: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: await res.text(), truncated: false };
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      received += value.byteLength;
      if (received > limit) {
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  return { text: Buffer.concat(chunks).subarray(0, limit).toString('utf8'), truncated };
}
const TIMEOUT_MS = 25_000;

export const readUrlContentTool: Tool<ReadUrlContentInput, ReadUrlContentOutput> = {
  name: 'read_url_content',
  category: 'Network',
  icon: 'web',
  permission: 'auto',
  mutating: false,
  capabilities: ['net.outbound'],
  subjectKey: 'url',
  timeoutMs: TIMEOUT_MS,
  description:
    'Fetch content from a URL via HTTP request (invisible to USER). Use when: ' +
    '(1) extracting text from public pages, (2) reading static content/documentation, ' +
    '(3) batch processing multiple URLs, (4) speed is important, or (5) no visual interaction needed. ' +
    'Converts HTML to clean markdown. No JavaScript execution, no authentication.',
  usageHint:
    'Provide `url` (e.g. "https://example.com/docs"). Converts HTML to readable markdown, stripping ' +
    'scripts, styles, navigation bars, headers, and footers to conserve token budget. ' +
    'For pages requiring interactive login, JavaScript rendering, or visual inspection, use browser tools instead.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'URL to read content from.',
      },
      Url: {
        type: 'string',
        description: 'Case-tolerant alias for URL.',
      },
      maxBytes: {
        type: 'number',
        minimum: 1,
        maximum: MAX_READ_URL_BYTES,
        description: 'Optional cap on returned bytes. Omit to read the whole page.',
      },
    },
    additionalProperties: false,
  },
  async execute(input, ctx, opts) {
    const rawUrl = (input.url ?? input.Url)?.trim();
    if (!rawUrl) {
      throw new Error('read_url_content requires a valid `url` parameter.');
    }

    // Clamped here as well as bounded by the schema: the schema stops a model
    // call at the executor, but this tool is also called directly (other hosts,
    // tests), and that path never sees the validator. A non-finite value falls
    // back to the default rather than poisoning the arithmetic below.
    // An explicit per-call `maxBytes` wins; else the user's `limits.fetchBytes`;
    // else the whole page.
    const requested =
      typeof input.maxBytes === 'number' && Number.isFinite(input.maxBytes)
        ? Math.trunc(input.maxBytes)
        : positiveLimit(activeLimits().fetchBytes);
    const maxBytes =
      requested === undefined ? undefined : Math.min(Math.max(1, requested), MAX_READ_URL_BYTES);
    const signal = opts?.signal ?? ctx?.signal ?? new AbortController().signal;

    const res = await guardedFetch(
      rawUrl,
      5,
      signal,
      {
        'user-agent': 'Mozilla/5.0 (compatible; WrongStackReader/1.0; +https://wrongstack.dev)',
        accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.5,*/*;q=0.1',
      },
      {
        allowedPrivateOrigins: browserPrivateOrigins(ctx?.projectRoot ?? ctx?.cwd ?? process.cwd()),
      },
    );

    const contentType = res.headers.get('content-type') ?? 'text/plain';
    const normalizedType = contentType.toLowerCase();
    if (/^image\/|^audio\/|^video\/|application\/octet-stream/.test(normalizedType)) {
      await res.body?.cancel().catch(() => {});
      throw new ToolValidationError({
        message: `read_url_content: refusing to read binary content-type "${contentType}"`,
        field: 'url',
      });
    }
    const { text: rawBody, truncated: readTruncated } = await readBounded(
      res,
      maxBytes === undefined ? MAX_READ_URL_BYTES : Math.min(maxBytes * 4, MAX_READ_URL_BYTES),
    );

    let content: string;
    if (normalizedType.includes('text/html') || normalizedType.includes('application/xhtml+xml')) {
      content = (await getTurndown()).turndown(rawBody).trim();
    } else if (normalizedType.includes('application/json')) {
      try {
        const parsed = JSON.parse(rawBody);
        content = JSON.stringify(parsed, null, 2);
      } catch {
        content = rawBody;
      }
    } else {
      content = rawBody;
    }

    if (maxBytes !== undefined && Buffer.byteLength(content, 'utf8') > maxBytes) {
      content = capBytesWithNotice(content, maxBytes, `[Content truncated at ${maxBytes} bytes]`);
    } else if (readTruncated) {
      content = `${content}

[Content truncated: response body exceeded the memory guard]`;
    }

    return {
      url: res.url || rawUrl,
      status: res.status,
      content_type: contentType,
      content,
    };
  },
};
