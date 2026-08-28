import type { MemoryAnchor, SageKind, SageScope, SageStatus } from '@wrongstack/sage';

const MEMORY_KINDS: SageKind[] = [
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

const MEMORY_SCOPES: SageScope[] = ['project', 'user', 'session', 'file', 'symbol'];

const MEMORY_STATUSES: SageStatus[] = [
  'active',
  'stale',
  'superseded',
  'contradicted',
  'archived',
  'deleted',
];

export interface ParsedMemoryFlags {
  text: string;
  kind?: SageKind;
  scope?: SageScope;
  status?: SageStatus;
  tags?: string[];
  anchors?: MemoryAnchor[];
  importance?: number | undefined;
  confidence?: number | undefined;
  freshness?: number | undefined;
  supersedes?: string[];
  contradicts?: string[];
  errors: string[];
}

/**
 * Parse `remember`/`update` argument tokens into structured SAGE fields.
 * Recognized flags take the single following token as their value; every other
 * token is collected as free-text and joined into `text`. `--tag`,
 * `--supersedes`, and `--contradicts` accept comma-separated lists.
 */
export function parseMemoryFlags(tokens: string[]): ParsedMemoryFlags {
  const words: string[] = [];
  const anchors: MemoryAnchor[] = [];
  const errors: string[] = [];
  const out: ParsedMemoryFlags = { text: '', errors };

  const nextValue = (i: number): { value: string | undefined; skip: boolean } => {
    const nxt = tokens[i + 1];
    if (nxt === undefined || nxt.startsWith('--')) return { value: undefined, skip: false };
    return { value: nxt, skip: true };
  };
  const csv = (value: string): string[] =>
    value
      .split(',')
      .map((part) => part.trim())
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
    const { value, skip } = nextValue(i);
    if (skip) i++;
    switch (name) {
      case 'kind':
        if (value && (MEMORY_KINDS as string[]).includes(value)) out.kind = value as SageKind;
        else errors.push(`--kind must be one of: ${MEMORY_KINDS.join(', ')}.`);
        break;
      case 'scope':
        if (value && (MEMORY_SCOPES as string[]).includes(value)) out.scope = value as SageScope;
        else errors.push(`--scope must be one of: ${MEMORY_SCOPES.join(', ')}.`);
        break;
      case 'status':
        if (value && (MEMORY_STATUSES as string[]).includes(value))
          out.status = value as SageStatus;
        else errors.push(`--status must be one of: ${MEMORY_STATUSES.join(', ')}.`);
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
      case 'agent':
        if (value) anchors.push({ type: 'agent', role: value });
        else
          errors.push(
            '--agent needs a role id (fleet roster member or .wrongstack/agents/<role> directory).',
          );
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

interface ParsedForFileFlags {
  singleLine: number | undefined;
  limit: number;
  showDeleted: boolean;
  errors: string[];
}

/**
 * Parse `for-file` argument tokens. Kept deliberately separate from
 * `parseMemoryFlags` so that the for-file flag set (line/limit/show-deleted)
 * does not widen the whitelist of the shared remember/update parser, which
 * validates against the canonical memory-record field set.
 */
export function parseForFileFlags(tokens: string[]): ParsedForFileFlags {
  const out: ParsedForFileFlags = {
    singleLine: undefined,
    limit: 50,
    showDeleted: false,
    errors: [],
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    if (!token.startsWith('--')) continue;
    const name = token.slice(2).toLowerCase();
    const next = tokens[i + 1];
    if (name === 'line') {
      if (next === undefined || next.startsWith('--')) {
        out.errors.push('--line needs a 1-indexed line number.');
        continue;
      }
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        out.errors.push(`--line must be a positive integer (got "${next}").`);
        continue;
      }
      out.singleLine = parsed;
      i++;
    } else if (name === 'limit') {
      if (next === undefined || next.startsWith('--')) {
        out.errors.push('--limit needs a value between 1 and 200.');
        continue;
      }
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed < 1 || parsed > 200) {
        out.errors.push(`--limit must be between 1 and 200 (got "${next}").`);
        continue;
      }
      out.limit = parsed;
      i++;
    } else if (name === 'show-deleted' || name === 'show-deleted-memories') {
      out.showDeleted = true;
    } else {
      out.errors.push(`Unknown flag "--${name}".`);
    }
  }
  return out;
}
