import type { TextEdit } from './editor-indent';

const SLASHES = new Set(
  'ts tsx mts cts js jsx mjs cjs rs go java kt kts swift c h cc cpp hpp cs dart scala php zig jsonc'.split(
    ' ',
  ),
);
const HASH = new Set(
  'py sh bash zsh ps1 psm1 rb pl yaml yml toml r ex exs nix cmake mk dockerfile gitignore env'.split(
    ' ',
  ),
);
const DASHES = new Set('sql lua hs elm'.split(' '));

/**
 * The line comment marker for a file, from its extension (or a few well-known names), or null
 * when the language has no line comment (CSS, HTML, JSON, Markdown…) or is not recognised.
 */
export function lineCommentMarker(path: string): string | null {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (name === 'dockerfile' || name === 'makefile' || name.startsWith('.env')) return '#';
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  if (SLASHES.has(extension)) return '//';
  if (HASH.has(extension)) return '#';
  if (DASHES.has(extension)) return '--';
  return null;
}

const lineStart = (text: string, offset: number) => text.lastIndexOf('\n', offset - 1) + 1;

/**
 * Ctrl+/ over the touched lines: when every non-blank line is already commented the markers
 * (and one following space) are removed, otherwise `marker ` is added at the shallowest indent.
 * Blank lines are left alone. The selection moves with the text it covered.
 */
export function toggleLineComment(
  text: string,
  start: number,
  end: number,
  marker: string,
): TextEdit {
  const first = lineStart(text, start);
  const last = end > start && text[end - 1] === '\n' ? end - 1 : end;
  const close = text.indexOf('\n', last);
  const stop = close < 0 ? text.length : close;
  const lines = text.slice(first, stop).split('\n');
  const filled = lines.filter((line) => line.trim());
  if (!filled.length) return { text, start, end };
  const commented = filled.every((line) => line.trimStart().startsWith(marker));
  const column = Math.min(...filled.map((line) => /^[ \t]*/.exec(line)![0].length));
  // Each line's change as [column, removed, inserted], to move the selection offsets with it.
  const changes: [number, number, string][] = [];
  const next = lines.map((line) => {
    if (!line.trim()) {
      changes.push([0, 0, '']);
      return line;
    }
    if (commented) {
      const at = line.indexOf(marker);
      const cut = marker.length + (line[at + marker.length] === ' ' ? 1 : 0);
      changes.push([at, cut, '']);
      return line.slice(0, at) + line.slice(at + cut);
    }
    changes.push([column, 0, `${marker} `]);
    return `${line.slice(0, column)}${marker} ${line.slice(column)}`;
  });
  // A selection that starts exactly where a marker is inserted grows to include it.
  const move = (offset: number, keepBefore = false) => {
    let lineOffset = first,
      shift = 0;
    for (const [index, line] of lines.entries()) {
      const [at, removed, inserted] = changes[index]!;
      const position = lineOffset + at;
      if (offset > position + removed || (offset === position + removed && !keepBefore))
        shift += inserted.length - removed;
      else if (offset > position) shift += position - offset;
      else break;
      lineOffset += line.length + 1;
    }
    return offset + shift;
  };
  return {
    text: text.slice(0, first) + next.join('\n') + text.slice(stop),
    start: move(start, start !== end),
    end: move(end),
  };
}
