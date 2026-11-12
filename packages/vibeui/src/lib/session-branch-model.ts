export interface VibeBranchDescriptor {
  id: string;
  name: string;
  parentBranchId: string | null;
  forkSeq: number;
  createdAt: string;
  lastActivityAt: string;
  status: 'active' | 'folded' | 'archived';
  turnCount: number;
}

export interface VibeSessionTreeSnapshot {
  activeBranchId: string;
  branches: Record<string, VibeBranchDescriptor>;
  headSeq: number;
}

export interface VibeBranchRow {
  branch: VibeBranchDescriptor;
  depth: number;
  isActive: boolean;
}

export function parseVibeSessionTree(raw: string): VibeSessionTreeSnapshot | null {
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<VibeSessionTreeSnapshot>;
    if (
      !parsed ||
      typeof parsed.activeBranchId !== 'string' ||
      !parsed.branches ||
      typeof parsed.branches !== 'object'
    ) {
      return null;
    }
    return {
      activeBranchId: parsed.activeBranchId,
      branches: parsed.branches as Record<string, VibeBranchDescriptor>,
      headSeq: typeof parsed.headSeq === 'number' ? parsed.headSeq : -1,
    };
  } catch {
    return null;
  }
}

export function flattenVibeBranchRows(tree: VibeSessionTreeSnapshot): VibeBranchRow[] {
  const all = Object.values(tree.branches);
  const childrenByParent = new Map<string, VibeBranchDescriptor[]>();
  for (const branch of all) {
    if (branch.parentBranchId === null) continue;
    const parentId = tree.branches[branch.parentBranchId] ? branch.parentBranchId : 'main';
    const list = childrenByParent.get(parentId) ?? [];
    list.push(branch);
    childrenByParent.set(parentId, list);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.forkSeq - b.forkSeq || a.createdAt.localeCompare(b.createdAt));
  }

  const root = tree.branches.main ??
    all.find((b) => b.parentBranchId === null) ?? {
      id: 'main',
      name: 'main',
      parentBranchId: null,
      forkSeq: 0,
      createdAt: new Date(0).toISOString(),
      lastActivityAt: new Date(0).toISOString(),
      status: 'active' as const,
      turnCount: 0,
    };

  const rows: VibeBranchRow[] = [];
  const visited = new Set<string>();
  const walk = (branch: VibeBranchDescriptor, depth: number) => {
    if (visited.has(branch.id)) return;
    visited.add(branch.id);
    rows.push({
      branch,
      depth,
      isActive: branch.id === tree.activeBranchId,
    });
    for (const child of childrenByParent.get(branch.id) ?? []) {
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

export function buildVibeTreeCommandArgs(
  action:
    | { kind: 'list' }
    | { kind: 'new'; name: string }
    | { kind: 'switch'; branchId: string; keepFiles?: boolean | undefined }
    | { kind: 'fold'; branchId: string },
): string {
  switch (action.kind) {
    case 'list':
      return 'list --json';
    case 'new':
      return `new ${action.name.trim()}`;
    case 'switch':
      return `switch ${action.branchId}${action.keepFiles ? ' --keep-files' : ''}`;
    case 'fold':
      return `fold ${action.branchId}`;
  }
}
