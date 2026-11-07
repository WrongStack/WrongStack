/**
 * A list of changed files as a directory tree, with chains of single-child
 * directories folded into one node (`packages/webui/src`), the way editors
 * show "compact folders". Directories come before files, each sorted by name;
 * every directory carries its file count and line totals.
 */

export interface TreeFileLike {
  path: string;
  added: number;
  deleted: number;
}

export interface CompactTreeDir<F extends TreeFileLike> {
  kind: 'dir';
  /** One or more path segments joined with `/`. */
  name: string;
  /** The full directory path, unique within the tree (a key and a collapse id). */
  path: string;
  children: CompactTreeNode<F>[];
  fileCount: number;
  added: number;
  deleted: number;
}

export interface CompactTreeFile<F extends TreeFileLike> {
  kind: 'file';
  name: string;
  file: F;
}

export type CompactTreeNode<F extends TreeFileLike> = CompactTreeDir<F> | CompactTreeFile<F>;

interface MutableDir<F extends TreeFileLike> {
  dirs: Map<string, MutableDir<F>>;
  files: CompactTreeFile<F>[];
}

function emptyDir<F extends TreeFileLike>(): MutableDir<F> {
  return { dirs: new Map(), files: [] };
}

function finish<F extends TreeFileLike>(dir: MutableDir<F>, prefix: string): CompactTreeNode<F>[] {
  const dirs: CompactTreeDir<F>[] = [...dir.dirs.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, child]) => {
      // Fold a directory whose only content is one directory into it.
      let folded = name;
      let node = child;
      while (node.files.length === 0 && node.dirs.size === 1) {
        const [[nextName, next]] = [...node.dirs.entries()] as [[string, MutableDir<F>]];
        folded = `${folded}/${nextName}`;
        node = next;
      }
      const path = prefix ? `${prefix}/${folded}` : folded;
      const children = finish(node, path);
      let fileCount = 0;
      let added = 0;
      let deleted = 0;
      for (const c of children) {
        if (c.kind === 'dir') {
          fileCount += c.fileCount;
          added += c.added;
          deleted += c.deleted;
        } else {
          fileCount += 1;
          added += c.file.added;
          deleted += c.file.deleted;
        }
      }
      return { kind: 'dir', name: folded, path, children, fileCount, added, deleted };
    });
  const files = [...dir.files].sort((a, b) => a.name.localeCompare(b.name));
  return [...dirs, ...files];
}

export function buildCompactFileTree<F extends TreeFileLike>(
  files: readonly F[],
): CompactTreeNode<F>[] {
  const root = emptyDir<F>();
  for (const file of files) {
    const normalizedPath = file.path.replace(/\\/g, '/');
    const parts = normalizedPath.split('/').filter(Boolean);
    const last = parts.pop();
    if (last === undefined) continue;
    // Git lists an untracked directory as `dir/`: it stays one entry, named `dir/`.
    const name = normalizedPath.endsWith('/') ? `${last}/` : last;
    let dir = root;
    for (const part of parts) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = emptyDir<F>();
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.push({ kind: 'file', name, file });
  }
  return finish(root, '');
}
