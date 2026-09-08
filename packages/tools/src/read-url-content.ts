import type { Tool } from '@wrongstack/core/types';
import TurndownService from 'turndown';
import { guardedFetch } from './_fetch-guard.js';

const TD = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
});

TD.addRule('stripDangerousElements', {
  filter: ['script', 'style', 'noscript'],
  replacement: () => '',
});

const PRUNED_BOILERPLATE_TAGS = new Set(['nav', 'header', 'footer', 'aside', 'svg', 'iframe']);
TD.remove((node) => PRUNED_BOILERPLATE_TAGS.has(node.nodeName.toLowerCase()));

export interface ReadUrlContentInput {
  /** Target web page URL to read. */
  url?: string | undefined;
  /** Antigravity parameter alias. */
  Url?: string | undefined;
  /** Maximum bytes to retrieve and return (default: 131,072 bytes). */
  maxBytes?: number | undefined;
}

export interface ReadUrlContentOutput {
  url: string;
  status: number;
  content_type: string;
  content: string;
}

const DEFAULT_MAX_BYTES = 131_072;
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
  maxOutputBytes: DEFAULT_MAX_BYTES,
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
        description: 'Maximum bytes to retrieve (default: 128KB).',
      },
    },
    additionalProperties: false,
  },
  async execute(input, ctx, opts) {
    const rawUrl = (input.url ?? input.Url)?.trim();
    if (!rawUrl) {
      throw new Error('read_url_content requires a valid `url` parameter.');
    }

    const maxBytes = input.maxBytes ?? DEFAULT_MAX_BYTES;
    const signal = opts?.signal ?? ctx?.signal;

    const res = await guardedFetch(rawUrl, {
      signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; WrongStackReader/1.0; +https://wrongstack.dev)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/json;q=0.5,*/*;q=0.1',
      },
    });

    const contentType = res.headers.get('content-type') ?? 'text/plain';
    const rawBody = await res.text();

    let content: string;
    if (contentType.includes('text/html') || contentType.includes('application/xhtml+xml')) {
      content = TD.turndown(rawBody).trim();
    } else if (contentType.includes('application/json')) {
      try {
        const parsed = JSON.parse(rawBody);
        content = JSON.stringify(parsed, null, 2);
      } catch {
        content = rawBody;
      }
    } else {
      content = rawBody;
    }

    if (Buffer.byteLength(content, 'utf8') > maxBytes) {
      const buf = Buffer.from(content, 'utf8');
      content = `${buf.subarray(0, maxBytes).toString('utf8')}\n\n[Content truncated at ${maxBytes} bytes]`;
    }

    return {
      url: res.url || rawUrl,
      status: res.status,
      content_type: contentType,
      content,
    };
  },
};
