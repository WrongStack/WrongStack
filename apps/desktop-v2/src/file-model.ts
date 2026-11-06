import { entries } from './engine-values';
import { displayDecimal } from './display-dates';

export function projectRelativePath(value: string, projectRoot: string): string {
  const normalize = (rawPath: string) => {
    const cleaned = rawPath
      .replaceAll('\\', '/')
      .replace(/^\/\/\?\//, '')
      .replace(/\/+$/, '');
    const drive = /^[a-z]:/i.exec(cleaned)?.[0];
    const absolute = Boolean(drive) || cleaned.startsWith('/');
    const rest = drive ? cleaned.slice(2) : cleaned;
    const parts: string[] = [];
    for (const part of rest.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') {
        if (parts.length && parts.at(-1) !== '..') parts.pop();
        else if (!absolute) parts.push(part);
      } else {
        parts.push(part);
      }
    }
    if (drive) return parts.length ? `${drive}/${parts.join('/')}` : drive;
    if (absolute) return `/${parts.join('/')}`;
    return parts.join('/');
  };
  const path = normalize(value),
    root = normalize(projectRoot);
  const windows = /^[a-z]:(?:\/|$)/i.test(root);
  const target = windows ? path.toLowerCase() : path,
    prefix = windows ? root.toLowerCase() : root;
  const slashPrefix = prefix === '/' ? '/' : `${prefix}/`;
  return target === prefix
    ? ''
    : target.startsWith(slashPrefix)
      ? path.slice(slashPrefix.length)
      : path;
}
export function workspaceFilePath(value: string, projectRoot: string, workdir: string): string {
  if (/^(?:[a-z]:[\\/]|[\\/])/i.test(value)) return projectRelativePath(value, projectRoot);
  const result: string[] = [];
  for (const part of `${projectRelativePath(workdir, projectRoot)}/${value}`
    .replaceAll('\\', '/')
    .split('/')) {
    if (!part || part === '.') continue;
    if (part === '..' && result.length && result.at(-1) !== '..') result.pop();
    else result.push(part);
  }
  return result.join('/');
}

export interface FileNode {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  ignored?: boolean;
  children: FileNode[];
}
export function fileTree(value: unknown): FileNode[] {
  return entries(value)
    .filter(
      (node) =>
        typeof node['path'] === 'string' &&
        typeof node['name'] === 'string' &&
        ['file', 'directory'].includes(String(node['type'])),
    )
    .map((node) => ({
      name: String(node['name']),
      path: String(node['path']).replaceAll('\\', '/'),
      type: node['type'] as 'file' | 'directory',
      ...(node['ignored'] === true ? { ignored: true } : {}),
      ...(typeof node['size'] === 'number' ? { size: node['size'] } : {}),
      children: fileTree(node['children']),
    }));
}
export function flattenFiles(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap((node) => [node, ...flattenFiles(node.children)]);
}
export function parentPath(path: string) {
  return path.replaceAll('\\', '/').split('/').slice(0, -1).join('/');
}
export function fileName(path: string) {
  return path.replaceAll('\\', '/').split('/').at(-1) ?? path;
}
/**
 * A file operation's failure in the display language. The engine passes OS failures through
 * as Node words them ("ENOENT: no such file or directory, stat 'D:\\p\\a.txt'"); those name
 * the file and what happened instead. Anything else is already worded for people.
 */
export function fileErrorText(
  error: string,
  t: (key: string, values: { name: string }) => string,
): string {
  if (error.includes('DRAFT_CONFLICT')) return t('fileView.draftConflict', { name: '' });
  const failure = /\b(ENOENT|EACCES|EPERM|EBUSY)\b[^']*'([^']+)'/.exec(error);
  // `String(error)` adds JavaScript's "Error: " to a message already worded for people.
  if (!failure) return error.replace(/(^|: )Error: /g, '$1');
  const key =
    failure[1] === 'ENOENT'
      ? 'missingOnDisk'
      : failure[1] === 'EBUSY'
        ? 'busyOnDisk'
        : 'deniedOnDisk';
  return t(`fileView.${key}`, { name: fileName(failure[2]!) });
}
export function byteSize(bytes: number) {
  return bytes < 1024
    ? `${bytes} B`
    : bytes < 1048576
      ? `${displayDecimal(bytes / 1024, 1)} KB`
      : `${displayDecimal(bytes / 1048576, 1)} MB`;
}
/**
 * A file manager row's accessible name: its action and path, then every column the row shows
 * (folder in search results, kind, size), so speech input can say any visible part of it.
 */
/** A file list's type column: "Folder" or the file's language, in the display language. */
export function fileKind(
  t: (key: string, values: Record<string, string>) => string,
  path: string,
  directory = false,
) {
  return directory ? t('fileView.folder', {}) : fileLanguage(path, t('fileView.plainText', {}));
}

export function fileRowName(
  t: (key: string, values: Record<string, string>) => string,
  node: FileNode,
  selecting: boolean,
  search: boolean,
) {
  return [
    t(selecting ? 'fileView.selectPath' : 'fileView.openPath', { path: node.path }),
    search ? parentPath(node.path) : '',
    fileKind(t, node.path, node.type === 'directory'),
    node.size === undefined ? '—' : byteSize(node.size),
  ]
    .filter(Boolean)
    .join(' ');
}
/** The file's language by extension; `plain` names any other file, in the display language. */
export function fileLanguage(path: string, plain = 'Plain text') {
  const extension = path.split('.').at(-1)?.toLowerCase() ?? '';
  return (
    (
      {
        ts: 'TypeScript',
        tsx: 'TypeScript React',
        js: 'JavaScript',
        jsx: 'JavaScript React',
        rs: 'Rust',
        py: 'Python',
        md: 'Markdown',
        json: 'JSON',
        css: 'CSS',
        html: 'HTML',
        yaml: 'YAML',
        yml: 'YAML',
        toml: 'TOML',
        sh: 'Shell',
        ps1: 'PowerShell',
      } as Record<string, string>
    )[extension] ?? plain
  );
}
export interface DiffLine {
  kind: 'same' | 'add' | 'remove';
  text: string;
  oldLine: number | null;
  newLine: number | null;
}
/** Bounded Myers line diff; large rewrites fall back to an accurate delete/add block. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before ? before.split('\n') : [],
    b = after ? after.split('\n') : [];
  let prefix = 0,
    suffix = 0;
  while (prefix < Math.min(a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  while (
    suffix < Math.min(a.length, b.length) - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const left = a.slice(prefix, a.length - suffix),
    right = b.slice(prefix, b.length - suffix);
  const trace: Map<number, number>[] = [];
  let frontier = new Map<number, number>([[1, 0]]),
    work = 0;
  let edits: { kind: DiffLine['kind']; text: string }[] | null = null;
  outer: for (let d = 0; d <= left.length + right.length; d++) {
    trace.push(new Map(frontier));
    for (let k = -d; k <= d; k += 2) {
      if (++work > 150000 || d > 1200) break outer;
      let x =
        k === -d || (k !== d && (frontier.get(k - 1) ?? -1) < (frontier.get(k + 1) ?? -1))
          ? (frontier.get(k + 1) ?? 0)
          : (frontier.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < left.length && y < right.length && left[x] === right[y]) {
        x++;
        y++;
      }
      frontier.set(k, x);
      if (x >= left.length && y >= right.length) {
        const result: { kind: DiffLine['kind']; text: string }[] = [];
        let cx = left.length,
          cy = right.length;
        for (let depth = d; depth >= 0; depth--) {
          const previous = trace[depth]!;
          const diagonal = cx - cy;
          const pk =
            diagonal === -depth ||
            (diagonal !== depth &&
              (previous.get(diagonal - 1) ?? -1) < (previous.get(diagonal + 1) ?? -1))
              ? diagonal + 1
              : diagonal - 1;
          const px = previous.get(pk) ?? 0,
            py = px - pk;
          while (cx > px && cy > py) {
            result.push({ kind: 'same', text: left[cx - 1]! });
            cx--;
            cy--;
          }
          if (depth > 0) {
            if (cx === px) {
              result.push({ kind: 'add', text: right[cy - 1]! });
              cy--;
            } else {
              result.push({ kind: 'remove', text: left[cx - 1]! });
              cx--;
            }
          }
        }
        edits = result.reverse();
        break outer;
      }
    }
  }
  const middle = edits ?? [
    ...left.map((text) => ({ kind: 'remove' as const, text })),
    ...right.map((text) => ({ kind: 'add' as const, text })),
  ];
  let oldLine = 0,
    newLine = 0;
  return [
    ...a.slice(0, prefix).map((text) => ({ kind: 'same' as const, text })),
    ...middle,
    ...(suffix ? a.slice(-suffix).map((text) => ({ kind: 'same' as const, text })) : []),
  ].map((line) => ({
    ...line,
    oldLine: line.kind === 'add' ? null : ++oldLine,
    newLine: line.kind === 'remove' ? null : ++newLine,
  }));
}
/** Open notes with their replies, as sent to the conversation; resolved notes are left out. */
export function reviewText(
  notes: {
    path: string;
    line: number;
    text: string;
    resolved?: boolean;
    replies?: { text: string }[];
  }[],
) {
  return notes
    .filter((note) => !note.resolved)
    .map((note) =>
      [
        `${note.path}:${note.line}`,
        note.text,
        ...(note.replies ?? []).map((reply) => `Reply: ${reply.text}`),
      ].join('\n'),
    )
    .join('\n\n');
}
/**
 * Inclusive 1-based lines covered by a text selection. A selection that ends at the very
 * start of a line does not include that line; an empty selection yields null.
 */
export function selectionLineRange(
  content: string,
  start: number,
  end: number,
): [number, number] | null {
  const from = Math.max(0, Math.min(start, end)),
    to = Math.min(content.length, Math.max(start, end));
  if (from === to) return null;
  const lineAt = (offset: number) => content.slice(0, offset).split('\n').length;
  const first = lineAt(from);
  const last = content[to - 1] === '\n' ? lineAt(to - 1) : lineAt(to);
  return [first, Math.max(first, last)];
}
/** Character offset of a 1-based line and 0-based column, clamped to that line. */
export function sourcePointOffset(content: string, line: number, column: number): number {
  let start = 0;
  for (let current = 1; current < line; current++) {
    const next = content.indexOf('\n', start);
    if (next < 0) return content.length;
    start = next + 1;
  }
  const end = content.indexOf('\n', start);
  return start + Math.max(0, Math.min(column, (end < 0 ? content.length : end) - start));
}
