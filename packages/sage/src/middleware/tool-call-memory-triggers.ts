import * as path from 'node:path';
import type { ToolCallPipelinePayload } from '@wrongstack/core/agent';

export type MemoryToolTrigger =
  | 'read'
  | 'tree'
  | 'grep'
  | 'glob'
  | 'codebase_search'
  | 'write'
  | 'edit'
  | 'patch';

export interface ExtractedTriggerContext {
  trigger: MemoryToolTrigger;
  paths: string[];
  queryText: string;
}

export function isMutationTrigger(trigger: MemoryToolTrigger): boolean {
  return trigger === 'write' || trigger === 'edit' || trigger === 'patch';
}

export function didMutate(toolName: string, input: Record<string, unknown>): boolean {
  if (toolName === 'replace') return input['dry_run'] === false;
  if (toolName === 'patch') return input['dry_run'] !== true;
  return true;
}

export function extractTrigger(
  toolName: string,
  input: Record<string, unknown>,
): ExtractedTriggerContext | undefined {
  switch (toolName) {
    case 'read':
      return {
        trigger: 'read',
        paths: stringValues(input.path),
        queryText: enrichPathQuery(stringValues(input.path)),
      };
    case 'tree':
      return {
        trigger: 'tree',
        paths: stringValues(input.path ?? '.'),
        queryText: enrichPathQuery(stringValues(input.path ?? '.')),
      };
    case 'grep':
      return {
        trigger: 'grep',
        paths: stringValues(input.path ?? '.'),
        queryText: joinQueryParts(
          input.pattern,
          input.glob,
          enrichPathQuery(stringValues(input.path ?? '.')),
        ),
      };
    case 'glob':
      return {
        trigger: 'glob',
        paths: stringValues(input.path ?? '.'),
        queryText: joinQueryParts(
          input.pattern,
          input.glob,
          enrichPathQuery(stringValues(input.path ?? '.')),
        ),
      };
    case 'codebase_search':
    case 'codebase-search':
      return {
        trigger: 'codebase_search',
        paths: stringValues(input.path),
        queryText: joinQueryParts(input.query, input.q, enrichPathQuery(stringValues(input.path))),
      };
    case 'write':
      return {
        trigger: 'write',
        paths: stringValues(input.path),
        queryText: enrichPathQuery(stringValues(input.path)),
      };
    case 'edit':
      return {
        trigger: 'edit',
        paths: stringValues(input.path),
        queryText: enrichPathQuery(stringValues(input.path)),
      };
    case 'replace': {
      const files = stringValues(input.files).flatMap(splitFileList);
      return {
        trigger: 'edit',
        paths: files,
        queryText: joinQueryParts(
          enrichPathQuery(files),
          ...stringValues(input.pattern),
          ...stringValues(input.glob),
        ),
      };
    }
    case 'patch': {
      const patchPaths = extractPatchPaths(input);
      return {
        trigger: 'patch',
        paths: patchPaths,
        queryText: joinQueryParts(input.directory, enrichPathQuery(patchPaths)),
      };
    }
    default:
      return undefined;
  }
}

function joinQueryParts(...parts: unknown[]): string {
  return parts
    .flatMap((part) => (typeof part === 'string' ? [part.trim()] : []))
    .filter((part) => part.length > 0)
    .join(' ');
}

export function enrichPathQuery(paths: string[]): string {
  const terms: string[] = [];
  for (const raw of paths) {
    const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '').trim();
    if (!normalized || normalized === '.') continue;
    terms.push(normalized);
    const segments = normalized.split('/').filter(Boolean);
    const base = segments[segments.length - 1];
    if (base) {
      terms.push(base);
      const stem = base.replace(/\.[a-z0-9]{1,8}$/i, '');
      if (stem && stem !== base) terms.push(stem);
    }
    if (segments.length >= 2) {
      const parent = segments[segments.length - 2]!;
      if (parent.length >= 3) terms.push(parent);
    }
  }
  return [...new Set(terms)].join(' ');
}

export function stringValues(value: unknown): string[] {
  if (typeof value === 'string' && value.trim()) return [value.trim()];
  if (Array.isArray(value))
    return value
      .filter(isString)
      .map((v) => v.trim())
      .filter(Boolean);
  return [];
}

export function isString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function splitFileList(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function extractPatchPaths(input: Record<string, unknown>): string[] {
  if (typeof input.patch !== 'string') return [];
  const strip =
    typeof input.strip === 'number'
      ? Number.isNaN(input.strip)
        ? 0
        : Math.max(0, Math.floor(input.strip))
      : 1;
  const directory = typeof input.directory === 'string' ? input.directory.trim() : '';
  const result: string[] = [];
  for (const match of input.patch.matchAll(/^\+\+\+\s+([^\t\r\n]+)/gm)) {
    const raw = match[1]?.trim();
    if (!raw || raw === '/dev/null') continue;
    const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    const stripped = normalized.split('/').filter(Boolean).slice(strip).join('/');
    if (!stripped) continue;
    result.push(directory ? path.join(directory, stripped) : stripped);
  }
  return [...new Set(result)];
}

export function extractResultPaths(content: string, trigger: MemoryToolTrigger): string[] {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return [];
  }
  const result: string[] = [];
  const visit = (current: unknown, key?: string): void => {
    if (typeof current === 'string') {
      if (key === 'path' || key === 'file' || key === 'file_path' || key === 'files')
        result.push(current);
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current) visit(item, key);
      return;
    }
    if (!current || typeof current !== 'object') return;
    for (const [childKey, child] of Object.entries(current as Record<string, unknown>)) {
      if (
        childKey === 'files' ||
        childKey === 'paths' ||
        childKey === 'path' ||
        childKey === 'file' ||
        childKey === 'file_path' ||
        (childKey === 'results' &&
          (trigger === 'glob' || trigger === 'tree' || trigger === 'codebase_search'))
      ) {
        visit(child, childKey === 'paths' || childKey === 'results' ? 'path' : childKey);
      }
    }
  };
  visit(value);
  return result;
}

export function resolveTriggerPaths(
  values: string[],
  ctx: ToolCallPipelinePayload['ctx'],
): string[] {
  const root = path.resolve(ctx.projectRoot);
  const base = path.resolve(ctx.workingDir ?? ctx.cwd ?? ctx.projectRoot);
  const result: string[] = [];
  for (const value of values) {
    if (/[*?{}[\]]/.test(value)) continue;
    const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(base, value);
    const relative = path.relative(root, absolute);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    result.push(absolute);
  }
  return [...new Set(result)];
}
