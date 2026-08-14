import type { TreeNode } from '@/stores/file-store';

export interface FlatRow {
  node: TreeNode;
  depth: number;
  emptyPlaceholder?: boolean | undefined;
}

export interface CrumbContext {
  absPath: string;
  relPath: string;
}

export interface CreatePromptState {
  dirPath: string;
  type: 'file' | 'directory';
}

export interface RenamePromptState {
  oldPath: string;
  initialName: string;
}
