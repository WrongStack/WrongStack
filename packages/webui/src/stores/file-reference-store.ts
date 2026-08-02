import { create } from 'zustand';

// ── Types ───────────────────────────────────────────────────────────────

export type FileReference =
  | { id: string; kind: 'file'; path: string }
  | {
      id: string;
      kind: 'range';
      path: string;
      startLine: number;
      endLine: number;
      preview: string;
    }
  | {
      id: string;
      kind: 'snippet';
      path: string;
      startLine: number;
      endLine: number;
      content: string;
    };

/** Distributive Omit — preserves the discriminated-union shape when stripping
 *  the `id` field, so each variant keeps its own required keys. A plain
 *  `Omit<FileReference, 'id'>` would flatten the union into one loose type. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type FileReferenceInput = DistributiveOmit<FileReference, 'id'>;

interface FileReferenceState {
  /** File/range/snippet references queued to be sent with the next chat message. */
  refs: FileReference[];
  addRef: (ref: FileReferenceInput) => void;
  removeRef: (id: string) => void;
  clearRefs: () => void;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function refId(): string {
  return `ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function languageFromPath(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
      return 'javascript';
    case 'json':
      return 'json';
    case 'md':
    case 'mdx':
      return 'markdown';
    case 'css':
      return 'css';
    case 'scss':
      return 'scss';
    case 'html':
    case 'htm':
      return 'html';
    case 'py':
      return 'python';
    case 'rs':
      return 'rust';
    case 'go':
      return 'go';
    case 'rb':
      return 'ruby';
    case 'java':
      return 'java';
    case 'c':
      return 'c';
    case 'cpp':
    case 'hpp':
      return 'cpp';
    case 'h':
      return 'c';
    case 'sh':
    case 'bash':
      return 'bash';
    case 'sql':
      return 'sql';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'toml':
      return 'toml';
    default:
      return '';
  }
}

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() ?? path;
}

function truncateContent(
  content: string,
  maxLines = 20,
  maxChars = 2000,
): { text: string; truncated: boolean } {
  const lines = content.split('\n');
  let truncated = false;
  let result = content;
  if (lines.length > maxLines) {
    result = lines.slice(0, maxLines).join('\n');
    truncated = true;
  }
  if (result.length > maxChars) {
    result = result.slice(0, maxChars);
    truncated = true;
  }
  if (truncated) {
    result = result.replace(/\s+$/, '') + '\n…';
  }
  return { text: result, truncated };
}

function completeReadContract(paths: readonly string[]): string {
  if (paths.length === 0) return '';
  return [
    '[File reference contract]',
    'Before answering or modifying anything related to these references, use the available file-reading tools to read each complete project file:',
    ...paths.map((path) => `- ${JSON.stringify(path)}`),
    'If a read is paginated or chunked, continue on the same path until EOF. Do not treat an inline preview as the complete file.',
  ].join('\n');
}

/**
 * Convert file references to markdown text. When a whole-file ref's content
 * is available in `fileContents` (map of path→content), it is rendered as
 * a code block instead of a bare `@path` mention so the LLM sees the actual
 * source code without needing an extra read call.
 */
export function refsToMarkdown(
  refs: FileReference[],
  fileContents?: Record<string, string>,
): string {
  if (refs.length === 0) return '';
  const blocks: string[] = [];
  const completeReadPaths = new Set<string>();
  for (const ref of refs) {
    if (ref.kind === 'file') {
      const content = fileContents?.[ref.path];
      if (content) {
        const lang = languageFromPath(ref.path);
        const fence = lang ? `\`\`\`${lang}` : '```';
        const rendered = truncateContent(content);
        const scope = rendered.truncated ? 'preview; complete read required' : 'entire file';
        blocks.push(`${fence}\n// ${ref.path} (${scope})\n${rendered.text}\n\`\`\``);
        if (rendered.truncated) completeReadPaths.add(ref.path);
      } else {
        blocks.push(`@${ref.path}`);
        completeReadPaths.add(ref.path);
      }
      continue;
    }
    const lang = languageFromPath(ref.path);
    const fence = lang ? `\`\`\`${lang}` : '```';
    const header = `// ${ref.path}:${ref.startLine}-${ref.endLine}`;
    const rendered = truncateContent(ref.kind === 'snippet' ? ref.content : ref.preview);
    blocks.push(`${fence}\n${header}\n${rendered.text}\n\`\`\``);
    if (rendered.truncated) completeReadPaths.add(ref.path);
  }
  const contract = completeReadContract([...completeReadPaths]);
  return [...blocks, contract].filter(Boolean).join('\n\n');
}

export function refLabel(ref: FileReference): string {
  const name = basename(ref.path);
  if (ref.kind === 'file') return name;
  return `${name}:${ref.startLine}-${ref.endLine}`;
}

// ── Store ───────────────────────────────────────────────────────────────

export const useFileReferenceStore = create<FileReferenceState>()((set, get) => ({
  refs: [],

  addRef: (ref) => {
    const state = get();
    // Avoid exact duplicate file refs.
    if (ref.kind === 'file') {
      const existing = state.refs.find((r) => r.kind === 'file' && r.path === ref.path);
      if (existing) return;
    }
    // Cast the spread: object-spread over a union doesn't reliably narrow
    // the result back to the union variant, so attach the id explicitly.
    const newRef = { ...ref, id: refId() } as FileReference;
    set({ refs: [...state.refs, newRef] });
  },

  removeRef: (id) => {
    set((state) => ({ refs: state.refs.filter((r) => r.id !== id) }));
  },

  clearRefs: () => set({ refs: [] }),
}));
