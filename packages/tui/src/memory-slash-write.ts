import type { MemoryPort } from '@wrongstack/core/types';
import { getSageSurface } from '@wrongstack/sage';
import type { MemoryAnchorLike } from './memory-slash-render.js';

export const MEMORY_WRITE_SUBS = new Set([
  'remember',
  'add',
  'update',
  'edit',
  'delete',
  'del',
  'forget',
  'rm',
]);

export const MEMORY_KIND_VALUES = [
  'fact',
  'decision',
  'convention',
  'preference',
  'warning',
  'anti_pattern',
  'workflow',
  'bug_root_cause',
  'file_note',
  'symbol_note',
  'command_note',
  'summary',
];
export const MEMORY_SCOPE_VALUES = ['project', 'user', 'session', 'file', 'symbol'];
export const MEMORY_STATUS_VALUES = [
  'active',
  'stale',
  'superseded',
  'contradicted',
  'archived',
  'deleted',
] as const;

export interface UpdateSageInput {
  text?: string | undefined;
  kind?: string | undefined;
  tags?: string[] | undefined;
  anchors?: MemoryAnchorLike[] | undefined;
  importance?: number | undefined;
  confidence?: number | undefined;
  freshness?: number | undefined;
  status?: string | undefined;
  supersedes?: string[] | undefined;
  contradicts?: string[] | undefined;
}

export interface ParsedMemoryFlags {
  text: string;
  kind?: string;
  scope?: string;
  status?: string;
  tags?: string[];
  anchors?: MemoryAnchorLike[];
  importance?: number | undefined;
  confidence?: number | undefined;
  freshness?: number | undefined;
  supersedes?: string[];
  contradicts?: string[];
  errors: string[];
}

export function parseMemoryFlags(tokens: string[]): ParsedMemoryFlags {
  const words: string[] = [];
  const anchors: MemoryAnchorLike[] = [];
  const errors: string[] = [];
  const out: ParsedMemoryFlags = { text: '', errors };

  const csv = (value: string): string[] =>
    value
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
  const num = (name: string, value: string | undefined): number | undefined => {
    if (value === undefined) {
      errors.push(`${name} needs a value between 0 and 1.`);
      return undefined;
    }
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
      errors.push(`${name} must be a number between 0 and 1 (got "${value}").`);
      return undefined;
    }
    return parsed;
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    if (!token.startsWith('--')) {
      words.push(token);
      continue;
    }
    const name = token.slice(2).toLowerCase();
    const nxt = tokens[i + 1];
    const value = nxt !== undefined && !nxt.startsWith('--') ? nxt : undefined;
    if (value !== undefined) i++;
    switch (name) {
      case 'kind':
        if (value && (MEMORY_KIND_VALUES as readonly string[]).includes(value)) out.kind = value;
        else errors.push(`--kind must be one of: ${MEMORY_KIND_VALUES.join(', ')}.`);
        break;
      case 'scope':
        if (value && MEMORY_SCOPE_VALUES.includes(value)) out.scope = value;
        else errors.push(`--scope must be one of: ${MEMORY_SCOPE_VALUES.join(', ')}.`);
        break;
      case 'status':
        if (value && (MEMORY_STATUS_VALUES as readonly string[]).includes(value))
          out.status = value;
        else errors.push(`--status must be one of: ${MEMORY_STATUS_VALUES.join(', ')}.`);
        break;
      case 'tag':
      case 'tags':
        if (value) out.tags = [...(out.tags ?? []), ...csv(value)];
        else errors.push('--tag needs a value (comma-separated for multiple).');
        break;
      case 'anchor':
      case 'file':
        if (value) anchors.push({ type: 'file', path: value });
        else errors.push('--anchor needs a file path.');
        break;
      case 'symbol': {
        if (!value) {
          errors.push('--symbol needs a value like path#SymbolName.');
          break;
        }
        const hash = value.lastIndexOf('#');
        if (hash <= 0 || hash === value.length - 1) {
          errors.push('--symbol must be path#SymbolName.');
          break;
        }
        anchors.push({ type: 'symbol', path: value.slice(0, hash), symbol: value.slice(hash + 1) });
        break;
      }
      case 'command':
        if (value) anchors.push({ type: 'command', command: value });
        else errors.push('--command needs a value.');
        break;
      case 'importance':
        out.importance = num('--importance', value);
        break;
      case 'confidence':
        out.confidence = num('--confidence', value);
        break;
      case 'freshness':
        out.freshness = num('--freshness', value);
        break;
      case 'supersedes':
        if (value) out.supersedes = [...(out.supersedes ?? []), ...csv(value)];
        else errors.push('--supersedes needs one or more memory ids.');
        break;
      case 'contradicts':
        if (value) out.contradicts = [...(out.contradicts ?? []), ...csv(value)];
        else errors.push('--contradicts needs one or more memory ids.');
        break;
      case 'text':
        if (value) words.push(value);
        else errors.push('--text needs a value.');
        break;
      default:
        errors.push(`Unknown flag "--${name}".`);
    }
  }

  out.text = words.join(' ').trim();
  if (anchors.length > 0) out.anchors = anchors;
  return out;
}

export function memErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function handleMemoryWrite(
  store: MemoryPort,
  sub: string,
  rest: string[],
): Promise<{ message: string }> {
  const Sage = getSageSurface(store);
  // remember has a legacy fallback; every other write op needs SAGE.
  if (sub === 'remember' || sub === 'add') {
    if (rest.length === 0) {
      return {
        message:
          'Usage: /memory remember <text> [--kind k] [--scope s] [--tag a,b] [--anchor path] [--symbol path#Name] [--command cmd] [--importance 0..1] [--confidence 0..1] [--supersedes id,id] [--contradicts id,id]',
      };
    }
    if (!Sage) {
      const text = rest.join(' ').trim();
      if (!text) return { message: 'Usage: /memory remember <text>' };
      await store.remember(text);
      return { message: `Remembered: ${text}` };
    }
    const parsed = parseMemoryFlags(rest);
    if (parsed.errors.length > 0)
      return { message: `Cannot remember:\n- ${parsed.errors.join('\n- ')}` };
    if (!parsed.text)
      return { message: 'Nothing to remember — provide the memory text before/after the flags.' };
    try {
      const memory = await Sage.rememberSage({
        text: parsed.text,
        ...(parsed.kind && { kind: parsed.kind }),
        ...(parsed.scope && { scope: parsed.scope }),
        ...(parsed.tags && { tags: parsed.tags }),
        ...(parsed.anchors && { anchors: parsed.anchors }),
        ...(parsed.importance !== undefined && { importance: parsed.importance }),
        ...(parsed.confidence !== undefined && { confidence: parsed.confidence }),
        ...(parsed.supersedes && { supersedes: parsed.supersedes }),
        ...(parsed.contradicts && { contradicts: parsed.contradicts }),
      } as never);
      const tags = memory.tags.length > 0 ? ` ${memory.tags.map((t) => `#${t}`).join(' ')}` : '';
      return { message: `Remembered \`${memory.id}\` [${memory.kind}] ${memory.text}${tags}` };
    } catch (err) {
      return { message: `Could not remember: ${memErr(err)}` };
    }
  }

  if (!Sage) {
    return { message: `\`/memory ${sub}\` requires the SAGE backend.` };
  }

  if (sub === 'update' || sub === 'edit') {
    const id = rest[0];
    if (!id)
      return {
        message:
          'Usage: /memory update <memory-id> [--text t] [--kind k] [--tag a,b] [--status active|stale|archived|deleted] [--importance 0..1] ...',
      };
    const parsed = parseMemoryFlags(rest.slice(1));
    if (parsed.errors.length > 0)
      return { message: `Cannot update:\n- ${parsed.errors.join('\n- ')}` };
    const patch: UpdateSageInput = {
      ...(parsed.text && { text: parsed.text }),
      ...(parsed.kind && { kind: parsed.kind }),
      ...(parsed.tags && { tags: parsed.tags }),
      ...(parsed.anchors && { anchors: parsed.anchors }),
      ...(parsed.importance !== undefined && { importance: parsed.importance }),
      ...(parsed.confidence !== undefined && { confidence: parsed.confidence }),
      ...(parsed.freshness !== undefined && { freshness: parsed.freshness }),
      ...(parsed.status && { status: parsed.status }),
      ...(parsed.supersedes && { supersedes: parsed.supersedes }),
      ...(parsed.contradicts && { contradicts: parsed.contradicts }),
    };
    if (Object.keys(patch).length === 0) {
      return {
        message: 'Nothing to update — pass at least one field (e.g. --text, --status, --tag).',
      };
    }
    try {
      const memory = await Sage.updateSage(id, patch as never);
      return {
        message: `Updated \`${memory.id}\` [${memory.kind}|${memory.status}] ${memory.text}`,
      };
    } catch (err) {
      return { message: `Could not update: ${memErr(err)}` };
    }
  }

  if (sub === 'delete' || sub === 'del') {
    const id = rest[0];
    if (!id) return { message: 'Usage: /memory delete <memory-id> [reason...]' };
    const reason = rest.slice(1).join(' ').trim() || undefined;
    try {
      const existing = await Sage.getSage(id);
      if (!existing) return { message: `No memory with id \`${id}\`.` };
      await Sage.deleteSage(id, reason, { force: true });
      return { message: `Deleted \`${id}\`.` };
    } catch (err) {
      return { message: `Could not delete: ${memErr(err)}` };
    }
  }

  // forget / rm — substring removal via the shared MemoryStore API.
  const query = rest.join(' ').trim();
  if (!query) return { message: 'Usage: /memory forget <query>' };
  try {
    const removed = await store.forget(query);
    return {
      message:
        removed === 0
          ? `No entries matched "${query}".`
          : `Forgot ${removed} entr${removed === 1 ? 'y' : 'ies'}.`,
    };
  } catch (err) {
    return { message: `Could not forget: ${memErr(err)}` };
  }
}
