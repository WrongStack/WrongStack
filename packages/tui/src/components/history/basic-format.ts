export function shortenPath(p: string, max: number): string {
  if (p.length <= max) return p;
  return `…${p.slice(p.length - (max - 1))}`;
}

const MAX_PREVIEW = 120;

export function previewArgs(input: unknown): string {
  let s: string;
  try {
    s = typeof input === 'string' ? input : JSON.stringify(input);
  } catch {
    s = String(input);
  }
  return collapse(s, MAX_PREVIEW);
}

export function previewOutput(output: string): string {
  return collapse(output, MAX_PREVIEW);
}

function collapse(s: string, max: number): string {
  const oneLine = s.replace(/\r?\n/g, '↵').replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

export function fmtTok(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const totalSec = Math.floor(ms / 1000);
  return `${Math.floor(totalSec / 60)}m${totalSec % 60}s`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncMid(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function stringOf(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export function numOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function tryParseJson(s: string): unknown {
  const t = s.trimStart();
  if (!t.startsWith('{') && !t.startsWith('[')) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function scanNumberedRange(text: string): {
  first?: number | undefined;
  last?: number | undefined;
  count: number;
} {
  let first: number | undefined;
  let last: number | undefined;
  let count = 0;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)→/);
    if (m?.[1]) {
      const n = Number.parseInt(m[1], 10);
      if (Number.isFinite(n)) {
        if (first === undefined) first = n;
        last = n;
        count++;
      }
    }
  }
  return { first, last, count };
}

export function countLines(text: string): number {
  if (!text) return 0;
  return text.replace(/\n$/, '').split('\n').length;
}

export function firstNonEmpty(text: string): string | undefined {
  if (!text) return undefined;
  const line = text.split('\n').find((l) => l.trim());
  return line ? line.replace(/\s+/g, ' ').trim() : undefined;
}

export function formatMatchHit(hit: unknown): string | undefined {
  if (typeof hit === 'string') {
    const m = hit.match(/^((?:[A-Za-z]:)?[^:]+):(\d+)[:\-](.*)$/);
    if (m?.[1] && m[2]) {
      const head = `${shortenPath(m[1], 40)}:${m[2]}`;
      const snippet = m[3]?.trim();
      return snippet ? `${head}  ${truncMid(snippet.replace(/\s+/g, ' '), 40)}` : head;
    }
    return truncMid(hit, 70);
  }
  if (hit && typeof hit === 'object') {
    const o = hit as Record<string, unknown>;
    const file =
      stringOf(o['file']) ??
      stringOf(o['path']) ??
      stringOf(o['filename']) ??
      stringOf(o['Filename']);
    const line =
      numOf(o['line']) ??
      numOf(o['lineNumber']) ??
      numOf(o['line_number']) ??
      numOf(o['LineNumber']);
    const snippet =
      stringOf(o['text']) ??
      stringOf(o['match']) ??
      stringOf(o['preview']) ??
      stringOf(o['lineContent']) ??
      stringOf(o['LineContent']) ??
      stringOf(o['line_content']);
    if (file) {
      const head = line !== undefined ? `${shortenPath(file, 40)}:${line}` : shortenPath(file, 50);
      return snippet ? `${head}  ${truncMid(snippet.replace(/\s+/g, ' '), 40)}` : head;
    }
    if (snippet) return truncMid(snippet, 70);
  }
  return undefined;
}
