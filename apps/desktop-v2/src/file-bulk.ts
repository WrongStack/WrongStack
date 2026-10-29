import { replaceAllMatches } from './editor-find';

/** Selected paths without those already covered by a selected ancestor folder. */
export function topLevelPaths(paths: readonly string[]): string[] {
  const unique = [...new Set(paths)].toSorted();
  return unique.filter(
    (path) => !unique.some((other) => other !== path && path.startsWith(`${other}/`)),
  );
}

/** Project-relative destination folder; empty, `.` and `./` mean the project root. */
export function bulkDestination(value: string): string {
  const folder = value
    .trim()
    .replace(/^(?:\.\/)+/, '')
    .replace(/\/+$/, '');
  return folder === '' || folder === '.' ? '.' : folder;
}

/** The new location of `path` after `from` moved to `to`, or null when it is unaffected. */
export function relocatedPath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? to + path.slice(from.length) : null;
}

export interface BulkOutcome {
  done: string[];
  failed: { path: string; error: string }[];
}

/**
 * Runs one operation per path in order. A failure is recorded and the rest still run, so the
 * report says exactly which items changed; nothing is retried.
 */
export async function runBulk(
  paths: readonly string[],
  operation: (path: string) => Promise<void>,
  shouldStop: () => boolean = () => false,
): Promise<BulkOutcome & { skipped: string[] }> {
  const outcome = {
    done: [] as string[],
    failed: [] as BulkOutcome['failed'],
    skipped: [] as string[],
  };
  for (const [index, path] of paths.entries()) {
    if (shouldStop()) {
      outcome.skipped.push(...paths.slice(index));
      break;
    }
    try {
      await operation(path);
      outcome.done.push(path);
    } catch (error) {
      outcome.failed.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcome;
}

export function bulkSummary(
  verb: 'Moved' | 'Copied' | 'Deleted' | 'Renamed',
  total: number,
  outcome: BulkOutcome & { skipped: string[] },
): string {
  const parts = [`${verb} ${outcome.done.length} of ${total} items.`];
  if (outcome.failed.length)
    parts.push(
      `Failed: ${outcome.failed.map((item) => `${item.path} (${item.error})`).join('; ')}.`,
    );
  if (outcome.skipped.length) parts.push(`Not attempted: ${outcome.skipped.join(', ')}.`);
  return parts.join(' ');
}

export interface RenameStep {
  from: string;
  to: string;
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const parentOf = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/**
 * Renames each selected item in place by replacing literal text in its name (never its folder).
 * Items whose name does not change are listed as unchanged. Invalid names, two items reaching
 * the same name, and a new name equal to another selected item (a swap or chain) are problems:
 * the batch must not start while any remain. Existing unselected targets are refused by the
 * engine per item.
 */
export function bulkRenamePlan(
  paths: readonly string[],
  find: string,
  replacement: string,
  caseSensitive: boolean,
): { steps: RenameStep[]; unchanged: string[]; problems: string[] } {
  const steps: RenameStep[] = [],
    unchanged: string[] = [],
    problems: string[] = [];
  if (!find) return { steps, unchanged: [...paths], problems };
  for (const path of paths) {
    const name = baseName(path);
    const next = replaceAllMatches(name, find, replacement, caseSensitive).text.trim();
    if (next === name) unchanged.push(path);
    else if (!next || next === '.' || next === '..' || /[\\/]/.test(next))
      problems.push(`${path}: "${next}" is not a valid name.`);
    else {
      const parent = parentOf(path);
      steps.push({ from: path, to: parent ? `${parent}/${next}` : next });
    }
  }
  // Windows and macOS folders usually ignore case, so names that differ only by case collide.
  const key = (path: string) => path.toLowerCase();
  const selected = new Set(paths.map(key));
  const seen = new Map<string, string>();
  for (const step of steps) {
    const target = key(step.to);
    const earlier = seen.get(target);
    if (earlier) problems.push(`${earlier} and ${step.from} would both become ${step.to}.`);
    else seen.set(target, step.from);
    if (selected.has(target) && target !== key(step.from))
      problems.push(`${step.from} would take the name of selected item ${step.to}.`);
  }
  return { steps, unchanged, problems };
}

/** SHA-256 of empty content: a copy writes only into the empty file it just created. */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** The path a copy of `path` gets inside `destination` ("." is the project root). */
export function copyTarget(path: string, destination: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return destination === '.' ? name : `${destination}/${name}`;
}

export const MAX_FOLDER_COPY_FILES = 200;
export const MAX_FOLDER_COPY_BYTES = 8 * 1024 * 1024;
/** The engine stops listing below this depth without saying so. */
const TREE_DEPTH_LIMIT = 10;

interface TreeEntry {
  path: string;
  type: string;
  children?: unknown;
}

/**
 * Folders and files to create for copying the folder at `path`, from the engine's tree of that
 * folder, in creation order. `tooDeep` is set when the listing reached the engine's depth limit,
 * where entries may be missing.
 */
export function folderCopyPlan(
  tree: unknown,
  path: string,
  destination: string,
): { dirs: string[]; files: RenameStep[]; tooDeep: boolean } {
  const root = copyTarget(path, destination);
  const dirs = [root],
    files: RenameStep[] = [];
  let tooDeep = false;
  const walk = (nodes: unknown, depth: number) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes as TreeEntry[]) {
      if (!node || typeof node.path !== 'string' || !node.path.startsWith(`${path}/`)) continue;
      const to = root + node.path.slice(path.length);
      if (node.type === 'directory') {
        dirs.push(to);
        if (depth >= TREE_DEPTH_LIMIT) tooDeep = true;
        walk(node.children, depth + 1);
      } else if (node.type === 'file') files.push({ from: node.path, to });
    }
  };
  walk(tree, 0);
  return { dirs, files, tooDeep };
}
