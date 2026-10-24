/**
 * Per-file read/mutation lifecycle analysis over the tool history, used by
 * compaction elision to tell superseded reads from live ones. Split out of
 * compaction-elision.ts.
 */
import type { ToolResultBlock, ToolUseBlock } from '@wrongstack/contracts/types/blocks';
import type { Message } from '@wrongstack/contracts/types/messages';
import { PATH_BACKSLASH_PATTERN } from './compaction-elision-summaries.js';

export interface FileToolLifecycle {
  activeReadIds: Set<string>;
  staleReadPaths: Map<string, string>;
}

function isReadToolName(name: string): boolean {
  return /^(read|read_file|open_file|view|view_file)$/.test(name.toLowerCase());
}

function isFileMutationToolName(name: string): boolean {
  return /^(edit|write|replace|patch|apply_patch)$/.test(name.toLowerCase());
}

function didFileMutationRun(use: ToolUseBlock): boolean {
  const name = use.name.toLowerCase();
  if (name === 'replace') return use.input?.['dry_run'] === false;
  if (name === 'patch') return use.input?.['dry_run'] !== true;
  return true;
}

function sameFilePath(a: string, b: string): boolean {
  if (a === b) return true;
  const aAbsolute = /^(?:[a-z]:\/|\/)/.test(a);
  const bAbsolute = /^(?:[a-z]:\/|\/)/.test(b);
  if (aAbsolute === bAbsolute) return false;
  return aAbsolute ? a.endsWith(`/${b}`) : b.endsWith(`/${a}`);
}

export function readPathOf(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  for (const key of ['file_path', 'path', 'file', 'filename']) {
    const v = input[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

export function normalizePathKey(p: string): string {
  return p.replace(PATH_BACKSLASH_PATTERN, '/').replace(/^\.\//, '').toLowerCase();
}

function mutationPathKeys(use: ToolUseBlock, result: ToolResultBlock): string[] {
  const paths = new Set<string>();
  const direct = readPathOf(use.input);
  if (direct) paths.add(normalizePathKey(direct));

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.content);
  } catch {
    return [...paths];
  }
  const visit = (value: unknown, key = ''): void => {
    if (typeof value === 'string') {
      if (/^(path|file|file_path|filename|files)$/.test(key) && value.trim()) {
        paths.add(normalizePathKey(value.trim()));
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) {
      visit(child, childKey);
    }
  };
  visit(parsed);
  return [...paths];
}

export function analyzeFileToolLifecycle(
  messages: readonly Message[],
  acknowledgedBefore: number,
): FileToolLifecycle {
  const uses = new Map<string, ToolUseBlock>();
  const activeByPath = new Map<string, Set<string>>();
  const staleReadPaths = new Map<string, string>();

  for (let i = 0; i < acknowledgedBefore; i++) {
    const message = messages[i];
    if (!message || typeof message.content === 'string') continue;
    for (const block of message.content) {
      if (block.type === 'tool_use') {
        uses.set(block.id, block);
        continue;
      }
      if (block.type !== 'tool_result' || block.is_error === true) continue;
      const use = uses.get(block.tool_use_id);
      if (!use) continue;
      if (isReadToolName(use.name)) {
        const rawPath = readPathOf(use.input);
        if (!rawPath) continue;
        const pathKey = normalizePathKey(rawPath);
        const matchingPath = [...activeByPath.keys()].find((activePath) =>
          sameFilePath(activePath, pathKey),
        );
        const canonicalPath = matchingPath ?? pathKey;
        const reads = activeByPath.get(canonicalPath) ?? new Set<string>();
        reads.add(block.tool_use_id);
        activeByPath.set(canonicalPath, reads);
        continue;
      }

      if (!isFileMutationToolName(use.name) || !didFileMutationRun(use)) continue;
      for (const mutationPath of mutationPathKeys(use, block)) {
        for (const [activePath, activeIds] of activeByPath) {
          if (!sameFilePath(activePath, mutationPath)) continue;
          for (const activeId of activeIds) staleReadPaths.set(activeId, activePath);
          activeByPath.delete(activePath);
        }
      }
    }
  }

  return {
    activeReadIds: new Set([...activeByPath.values()].flatMap((ids) => [...ids])),
    staleReadPaths,
  };
}
