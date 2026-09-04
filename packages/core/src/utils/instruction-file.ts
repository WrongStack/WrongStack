import { readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Cache of resolved instruction text, keyed by the relative path. Bundled
 * instruction files are immutable for the process lifetime, so re-reading them
 * on every call (some callers do so per LLM request) is wasted disk I/O.
 */
const textCache = new Map<string, string>();

/** Resolved once — the candidate roots only depend on this module's location. */
let rootCandidates: string[] | undefined;

export function readBundledInstructionText(relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) return '';
  const cached = textCache.get(relativePath);
  if (cached !== undefined) return cached;

  let resolved = '';
  for (const root of instructionRootCandidates()) {
    try {
      resolved = readFileSync(path.join(root, relativePath), 'utf8').trimEnd();
      break;
    } catch {
      // try next candidate
    }
  }
  textCache.set(relativePath, resolved);
  return resolved;
}

export function renderInstructionTemplate(
  template: string,
  values: Record<string, string>,
): string {
  if (typeof template !== 'string') return '';
  if (!values || typeof values !== 'object') return template;
  return template.replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (match, key: string) =>
    Object.hasOwn(values, key) ? (values[key] ?? '') : match,
  );
}

function instructionRootCandidates(): string[] {
  if (rootCandidates !== undefined) return rootCandidates;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, '../../instructions'),
    path.resolve(here, '../instructions'),
    path.resolve(here, 'instructions'),
  ];
  rootCandidates = candidates.sort((a, b) => Number(!isDirectory(a)) - Number(!isDirectory(b)));
  return rootCandidates;
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
