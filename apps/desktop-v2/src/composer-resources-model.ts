export interface ComposerFileReference {
  path: string;
  /** Inclusive 1-based line range that marks the relevant section of the file. */
  lines?: [number, number];
  /** Exact text the user selected when attaching; the file on disk may differ. */
  snippet?: string;
}
export const MAX_REFERENCE_LINE = 10_000_000;
export const MAX_SNIPPET_CHARS = 8_000;
export function validSnippet(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= MAX_SNIPPET_CHARS;
}
/** The quoted text on one short line, for chips and titles. */
export function snippetSummary(snippet: string, max = 40): string {
  const line = snippet.trim().replace(/\s+/g, ' ');
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
export function validReferenceLines(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((line) => Number.isSafeInteger(line) && line >= 1 && line <= MAX_REFERENCE_LINE) &&
    value[0] <= value[1]
  );
}
/** Identity of one reference: the same file with another range or quote is another reference. */
export function referenceKey(ref: ComposerFileReference): string {
  return JSON.stringify([ref.path, ref.lines ?? null, ref.snippet ?? null]);
}
/**
 * Adds a reference unless the same one is attached already. A file referenced whole needs no
 * second whole-file entry; ranges and quotes of it are kept alongside.
 */
export function withReference(
  refs: readonly ComposerFileReference[],
  ref: ComposerFileReference,
): ComposerFileReference[] {
  const key = referenceKey(ref);
  return refs.some((item) => referenceKey(item) === key) ? [...refs] : [...refs, ref];
}
export function referenceLabel(ref: ComposerFileReference): string {
  const base = ref.lines
    ? ref.lines[0] === ref.lines[1]
      ? `${ref.path}:${ref.lines[0]}`
      : `${ref.path}:${ref.lines[0]}-${ref.lines[1]}`
    : ref.path;
  return ref.snippet ? `${base} “${snippetSummary(ref.snippet)}”` : base;
}
export interface PromptVariable {
  name: string;
  description?: string;
  default?: string;
  required?: boolean;
  multiline?: boolean;
  enum?: string[];
}
const rangeNote =
  'Line ranges mark the relevant section; read beyond them when the task needs more context.';
const snippetNote =
  'Snippets are the exact text the user selected when attaching it, possibly from unsaved editor text; the file on disk may differ.';
const referenceReadContract =
  'Read each referenced file from this project root with the available file-reading tools before answering or editing it. Continue paginated reads until EOF; filenames alone are not file contents.';

/** Append only; choosing a resource must never silently replace an unsent draft. */
export function appendToDraft(draft: string, insertion: string): string {
  return draft.trim() ? `${draft.trimEnd()}\n\n${insertion}` : insertion;
}
export function renderPromptTemplate(content: string, values: Record<string, string>): string {
  return content.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, name: string) =>
    Object.hasOwn(values, name) && values[name] ? values[name]! : whole,
  );
}
export function referenceMessage(
  text: string,
  refs: readonly ComposerFileReference[],
  projectRoot: string,
): string {
  if (!refs.length) return text.trim();
  // One entry per distinct reference: a file may carry several ranges or quotes.
  const unique = [...new Map(refs.map((ref) => [referenceKey(ref), ref])).values()];
  const root = projectRoot
    .replace(/^\\\\\?\\/, '')
    .replaceAll('\\', '/')
    .replace(/\/$/, '');
  return [
    text.trim(),
    '[Project file references]',
    `Project root: ${JSON.stringify(root)}`,
    ...unique.map(
      (ref) =>
        `- ${JSON.stringify(ref.path)}${ref.lines ? ` lines ${ref.lines[0]}-${ref.lines[1]}` : ''}${
          ref.snippet ? ` snippet ${JSON.stringify(ref.snippet)}` : ''
        }`,
    ),
    unique.some((ref) => ref.lines) ? rangeNote : '',
    unique.some((ref) => ref.snippet) ? snippetNote : '',
    referenceReadContract,
  ]
    .filter(Boolean)
    .join('\n\n');
}
export function splitReferenceMessage(value: string): {
  text: string;
  paths: string[];
  references: ComposerFileReference[];
} {
  const marker = '[Project file references]';
  const plain = { text: value, paths: [], references: [] };
  const start = value.lastIndexOf(marker);
  if (start < 0 || !value.endsWith(referenceReadContract)) return plain;
  try {
    const references = value
      .slice(start + marker.length)
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line): ComposerFileReference | null => {
        const match =
          /^- ("(?:[^"\\]|\\.)*")(?: lines (\d+)-(\d+))?(?: snippet ("(?:[^"\\]|\\.)*"))?$/.exec(
            line,
          );
        if (!match) return null;
        const path = JSON.parse(match[1]!) as unknown;
        if (typeof path !== 'string' || !path) return null;
        const lines = match[2] ? [Number(match[2]), Number(match[3])] : undefined;
        if (lines && !validReferenceLines(lines)) return null;
        const snippet = match[4] === undefined ? undefined : (JSON.parse(match[4]) as unknown);
        if (snippet !== undefined && !validSnippet(snippet)) return null;
        return {
          path,
          ...(lines ? { lines: lines as [number, number] } : {}),
          ...(snippet === undefined ? {} : { snippet }),
        };
      });
    if (!references.length || references.some((ref) => !ref)) return plain;
    const refs = references as ComposerFileReference[];
    return {
      text: value.slice(0, start).trimEnd(),
      paths: [...new Set(refs.map((ref) => ref.path))],
      references: refs,
    };
  } catch {
    return plain;
  }
}
export function fileMention(
  text: string,
  cursor: number,
): { start: number; end: number; query: string } | null {
  const prefix = text.slice(0, cursor);
  const match = /(?:^|[\s(])@([^\s@]*)$/.exec(prefix);
  if (!match) return null;
  const start = prefix.lastIndexOf('@');
  const line = prefix.slice(prefix.lastIndexOf('\n') + 1);
  if (
    (prefix.match(/^\s*(?:```|~~~)/gm)?.length ?? 0) % 2 ||
    (line.match(/(?<!\\)`/g)?.length ?? 0) % 2
  )
    return null;
  return { start, end: cursor, query: match[1] ?? '' };
}
export const desktopCommands = [
  { name: '/help', description: 'Show desktop commands', action: 'help' },
  {
    name: '/prompt',
    aliases: ['/prompts'],
    description: 'Browse project and user prompt templates',
    action: 'library',
  },
  { name: '/history', description: 'Read this project’s prompt journal', action: 'journal' },
  {
    name: '/sessions',
    aliases: ['/session-history'],
    description: 'Browse this project’s recorded conversations',
    action: 'history',
  },
  {
    name: '/context',
    aliases: ['/debug'],
    description: 'Inspect this session’s context and instructions',
    action: 'context',
  },
  { name: '/compact', description: 'Compact this session’s context', action: 'compact' },
  {
    name: '/compact!',
    description: 'Aggressively compact this session’s context',
    action: 'compact-aggressive',
  },
  {
    name: '/repair',
    description: 'Repair orphan tool/result blocks in this session',
    action: 'repair',
  },
  {
    name: '/clear',
    description: 'Clear provider context; retain the on-disk conversation',
    action: 'clear',
  },
  {
    name: '/queue',
    description: 'Inspect pending prompts, or queue the text after this command',
    action: 'queue',
  },
  {
    name: '/btw',
    description: 'Send the following text using Message / BTW delivery',
    action: 'btw',
  },
  { name: '/steer', description: 'Stop and steer with the following instruction', action: 'steer' },
  {
    name: '/stop',
    aliases: ['/abort', '/interrupt', '/int'],
    description: 'Stop the active turn',
    action: 'stop',
  },
  { name: '/files', description: 'Open this project’s file manager', action: 'files' },
  {
    name: '/diff',
    aliases: ['/review'],
    description: 'Open this project’s changes and review',
    action: 'changes',
  },
  {
    name: '/skills',
    aliases: ['/skill'],
    description: 'Open this project’s skill library',
    action: 'skills',
  },
  { name: '/memory', description: 'Open project SAGE memory', action: 'memory' },
  { name: '/kanban', description: 'Open the project task board', action: 'kanban' },
  { name: '/mailbox', description: 'Open project correspondence and receipts', action: 'mailbox' },
  { name: '/atlas', description: 'Open project Code Atlas', action: 'atlas' },
  {
    name: '/settings',
    aliases: ['/model', '/auth', '/setup'],
    description: 'Open WrongStack provider and profile settings',
    action: 'settings',
  },
  { name: '/enhance', description: 'Toggle prompt refinement before sending', action: 'enhance' },
] as const;
export type DesktopCommandAction = (typeof desktopCommands)[number]['action'];
export function parseDesktopCommand(
  text: string,
): { action: DesktopCommandAction | 'unknown'; argument: string } | null {
  const match = /^\/([a-z][\w!-]*)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null; // //literal and absolute paths remain ordinary draft text.
  const name = `/${match[1]!.toLowerCase()}`;
  const found = desktopCommands.find(
    (command) =>
      command.name === name ||
      ('aliases' in command && (command.aliases as readonly string[]).includes(name)),
  );
  return { action: found?.action ?? 'unknown', argument: match[2]?.trim() ?? '' };
}
