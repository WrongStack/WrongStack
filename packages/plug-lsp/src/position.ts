interface LSPPosition {
  line: number;
  character: number;
}

interface HumanPosition {
  line: number;
  character: number;
}

interface LSPRange {
  start: LSPPosition;
  end: LSPPosition;
}

interface HumanRange {
  start: HumanPosition;
  end: HumanPosition;
}

export function humanToLSP(content: string, pos: HumanPosition): LSPPosition {
  const lines = splitLines(content);
  const lineIdx = clamp(pos.line - 1, 0, Math.max(0, lines.length - 1));
  /* v8 ignore next -- splitLines always returns at least one line. */
  const line = lines[lineIdx] ?? '';
  const byteCol = clamp(pos.character - 1, 0, Buffer.byteLength(line, 'utf8'));
  let bytes = 0;
  let utf16 = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > byteCol) break;
    bytes += b;
    utf16 += ch.length;
  }
  return { line: lineIdx, character: utf16 };
}

export function lspToHuman(content: string, pos: LSPPosition): HumanPosition {
  const lines = splitLines(content);
  const lineIdx = clamp(pos.line, 0, Math.max(0, lines.length - 1));
  /* v8 ignore next -- splitLines always returns at least one line. */
  const line = lines[lineIdx] ?? '';
  const utf16Col = clamp(pos.character, 0, line.length);
  let utf16 = 0;
  let bytes = 0;
  for (const ch of line) {
    if (utf16 + ch.length > utf16Col) break;
    utf16 += ch.length;
    bytes += Buffer.byteLength(ch, 'utf8');
  }
  return { line: lineIdx + 1, character: bytes + 1 };
}

export function humanToLSPRange(content: string, range: HumanRange): LSPRange {
  return { start: humanToLSP(content, range.start), end: humanToLSP(content, range.end) };
}

export function lspToHumanRange(content: string, range: LSPRange): HumanRange {
  return { start: lspToHuman(content, range.start), end: lspToHuman(content, range.end) };
}

export function splitLines(content: string): string[] {
  if (content.length === 0) return [''];
  return content.split(/\r\n|\r|\n/);
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}
