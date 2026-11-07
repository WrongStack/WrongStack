import { common, createLowlight } from 'lowlight';

const highlighter = createLowlight(common);
const extensions: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  py: 'python',
  rs: 'rust',
  sh: 'bash',
  ps1: 'powershell',
  yml: 'yaml',
  md: 'markdown',
  htm: 'xml',
  html: 'xml',
  svg: 'xml',
  vue: 'xml',
  cs: 'csharp',
  h: 'c',
  rb: 'ruby',
  dockerfile: 'dockerfile',
};

export function codeLanguage(hint: string) {
  const cleanHint = hint.split(/[?#]/)[0] ?? '';
  const name = cleanHint.toLowerCase().split(/[\\/]/).at(-1) ?? '';
  if (/^(dockerfile|containerfile)(\.|$)/.test(name)) return 'dockerfile';
  const extension = name.split('.').at(-1) ?? name;
  const language = Object.hasOwn(extensions, extension) ? extensions[extension]! : extension;
  return highlighter.registered(language) ? language : '';
}

export function highlightCode(value: string, language: string) {
  // Large logs remain fully selectable and copyable without expensive grammar work.
  if (!language || value.length > 100_000) return null;
  try {
    return highlighter.highlight(language, value);
  } catch {
    return null;
  }
}

export type JsonNode =
  | { kind: 'object' | 'array'; entries: { key: string; node: JsonNode }[] }
  | { kind: 'string' | 'number' | 'literal'; raw: string };

/** Validate JSON, then read its original tokens so IDs, exponents and duplicate keys stay intact. */
export function jsonContent(value: string): { formatted: string; node: JsonNode } | null {
  const source = value.trim();
  if (!/^[[{]/.test(source) || source.length > 200_000) return null;
  try {
    JSON.parse(source);
    const tokens = source.match(/"(?:\\.|[^"\\])*"|[^\s{}[\],:]+|[{}[\],:]/g) ?? [];
    if (tokens.length > 20_000) return null;
    let position = 0;
    function read(depth: number): JsonNode {
      if (depth > 60) throw new Error('Deep JSON uses the source reader');
      const raw = tokens[position++] ?? '';
      if (raw === '{' || raw === '[') {
        const entries: { key: string; node: JsonNode }[] = [];
        const close = raw === '{' ? '}' : ']';
        while (tokens[position] !== close) {
          const key =
            raw === '{' ? String(JSON.parse(tokens[position++] ?? '""')) : String(entries.length);
          if (raw === '{') position++; // colon, already validated above
          entries.push({ key, node: read(depth + 1) });
          if (tokens[position] === ',') position++;
        }
        position++;
        return { kind: raw === '{' ? 'object' : 'array', entries };
      }
      return {
        kind: raw.startsWith('"')
          ? 'string'
          : /^(true|false|null)$/.test(raw)
            ? 'literal'
            : 'number',
        raw,
      };
    }
    const node = read(0);
    let depth = 0;
    let formatted = '';
    for (let index = 0; index < tokens.length; index++) {
      const token = tokens[index];
      const next = tokens[index + 1];
      const previous = tokens[index - 1];
      if (token === '{' || token === '[') {
        formatted += token;
        depth++;
        if (next !== '}' && next !== ']') formatted += `\n${'  '.repeat(depth)}`;
      } else if (token === '}' || token === ']') {
        depth--;
        if (previous !== '{' && previous !== '[') formatted += `\n${'  '.repeat(depth)}`;
        formatted += token;
      } else if (token === ',') formatted += `,\n${'  '.repeat(depth)}`;
      else if (token === ':') formatted += ': ';
      else formatted += token;
    }
    return { formatted, node };
  } catch {
    return null;
  }
}
