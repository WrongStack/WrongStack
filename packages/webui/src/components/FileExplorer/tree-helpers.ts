import type { TreeNode } from '@/stores/file-store';
import type { FlatRow } from './types.js';

/** Flatten the visible portion of the tree (expanded dirs only). */
export function flattenTree(tree: TreeNode[], expandedDirs: ReadonlySet<string>): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (nodes: TreeNode[], depth: number) => {
    for (const n of nodes) {
      out.push({ node: n, depth });
      if (n.type === 'directory' && expandedDirs.has(n.path)) {
        const kids = n.children ?? [];
        if (kids.length > 0) walk(kids, depth + 1);
        else out.push({ node: n, depth: depth + 1, emptyPlaceholder: true });
      }
    }
  };
  walk(tree, 0);
  return out;
}

/**
 * Score a file path against a query — ported from the server-side
 * `rankFiles()` in `file-picker.ts` so the explorer and the chat `@`
 * picker use the same ranking: exact basename (100) > basename prefix
 * (60) > path substring (20), penalized by depth so shallow files win.
 */
export function scoreFile(filePath: string, q: string): number {
  const lower = filePath.toLowerCase();
  const base = lower.split('/').pop() ?? lower;
  let score = 0;
  if (base === q) score = 100;
  else if (base.startsWith(q)) score = 60;
  else if (lower.includes(q)) score = 20;
  else return -1;
  score -= lower.split('/').length;
  return score;
}

/** Recursively collect every file node in the tree (regardless of expansion). */
export function collectAllFiles(tree: TreeNode[]): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.type === 'file') out.push(n);
      else if (n.children) walk(n.children);
    }
  };
  walk(tree);
  return out;
}

/** Collect every directory path in the tree (for expand-all). */
export function collectDirPaths(tree: TreeNode[]): string[] {
  const out: string[] = [];
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      if (n.type === 'directory') {
        out.push(n.path);
        if (n.children) walk(n.children);
      }
    }
  };
  walk(tree);
  return out;
}

/**
 * Stable DOM id for a tree row button. Used by the role="tree" container's
 * aria-activedescendant (so screen readers can track the focused row) and by
 * the Shift+F10 handler to locate the focused row's bounding rect for menu
 * anchoring. encodeURIComponent keeps the id valid and unique per path.
 */
export function treeRowId(path: string): string {
  return `ws-file-row-${encodeURIComponent(path)}`;
}
