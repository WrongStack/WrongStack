import * as path from 'node:path';

export type CodeMapOperation = 'read' | 'write' | 'edit' | 'delete' | 'search';

export interface CodeMapFileTarget {
  filePath: string;
  operation: CodeMapOperation;
  line?: number | undefined;
  endLine?: number | undefined;
}

const TOOL_OPERATION: Record<string, CodeMapOperation> = {
  read: 'read',
  read_file: 'read',
  view: 'read',
  write: 'write',
  write_file: 'write',
  create_file: 'write',
  edit: 'edit',
  replace: 'edit',
  patch: 'edit',
  apply_patch: 'edit',
  delete: 'delete',
  delete_file: 'delete',
  remove: 'delete',
  unlink: 'delete',
  grep: 'search',
  search: 'search',
  codebase_search: 'search',
  'codebase-search': 'search',
};

function numberField(input: Record<string, unknown>, names: string[]): number | undefined {
  for (const name of names) {
    const value = input[name];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.floor(value);
  }
  return undefined;
}

function normalizeTarget(projectRoot: string, filePath: string): string {
  const root =
    typeof projectRoot === 'string' && projectRoot.length > 0 ? projectRoot : process.cwd();
  return path.normalize(path.isAbsolute(filePath) ? filePath : path.resolve(root, filePath));
}

export function normalizeCodeMapFileTarget(
  projectRoot: string,
  filePath: string,
  operation: 'write' | 'edit' | 'delete' | 'rename' = 'edit',
  line?: number,
  endLine?: number,
): CodeMapFileTarget {
  return {
    filePath: normalizeTarget(projectRoot, filePath),
    operation: operation === 'rename' ? 'edit' : operation,
    ...(line ? { line } : {}),
    ...(endLine ? { endLine } : {}),
  };
}

function patchTargets(patch: string): string[] {
  const targets: string[] = [];
  for (const line of patch.split(/\r?\n/)) {
    const match = /^\+\+\+\s+(?:b\/)?(.+?)(?:\t.*)?$/.exec(line);
    const target = match?.[1]?.trim();
    if (target && target !== '/dev/null') targets.push(target);
  }
  return targets;
}

/**
 * Convert heterogeneous tool inputs into canonical absolute file targets.
 * This is intentionally deterministic and shared by both standalone and CLI
 * WebUI event bridges so the browser never has to guess path roots.
 */
export function extractCodeMapFileTargets(
  projectRoot: string,
  toolName: string,
  rawInput: unknown,
): CodeMapFileTarget[] {
  const operation = TOOL_OPERATION[toolName.toLowerCase()];
  if (!operation || !rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) return [];
  const input = rawInput as Record<string, unknown>;
  const rawPaths: string[] = [];
  for (const key of ['path', 'file', 'filePath', 'target']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) rawPaths.push(value.trim());
  }
  const files = input['files'];
  if (Array.isArray(files)) {
    for (const value of files)
      if (typeof value === 'string' && value.trim()) rawPaths.push(value.trim());
  } else if (typeof files === 'string' && files.trim() && !/[?*{}[\]]/.test(files)) {
    rawPaths.push(files.trim());
  }
  if ((toolName === 'patch' || toolName === 'apply_patch') && typeof input['patch'] === 'string') {
    rawPaths.push(...patchTargets(input['patch']));
  }

  const line = numberField(input, ['line', 'offset', 'startLine', 'start_line', 'line_start']);
  const explicitEnd = numberField(input, ['endLine', 'end_line', 'line_end']);
  const limit = numberField(input, ['limit']);
  const endLine = explicitEnd ?? (line && limit ? line + limit - 1 : undefined);
  const seen = new Set<string>();
  const targets: CodeMapFileTarget[] = [];
  for (const rawPath of rawPaths) {
    const filePath = normalizeTarget(projectRoot, rawPath);
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    targets.push({
      filePath,
      operation,
      ...(line ? { line } : {}),
      ...(endLine ? { endLine } : {}),
    });
  }
  return targets;
}
