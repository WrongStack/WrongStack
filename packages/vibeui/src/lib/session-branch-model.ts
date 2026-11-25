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

function isVibeBranchDescriptor(value: unknown): value is VibeBranchDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const branch = value as Record<string, unknown>;
  return (
    typeof branch.id === 'string' &&
    branch.id.length > 0 &&
    typeof branch.name === 'string' &&
    (branch.parentBranchId === null || typeof branch.parentBranchId === 'string') &&
    typeof branch.forkSeq === 'number' &&
    Number.isSafeInteger(branch.forkSeq) &&
    branch.forkSeq >= 0 &&
    typeof branch.createdAt === 'string' &&
    typeof branch.lastActivityAt === 'string' &&
    (branch.status === 'active' || branch.status === 'folded' || branch.status === 'archived') &&
    typeof branch.turnCount === 'number' &&
    Number.isSafeInteger(branch.turnCount) &&
    branch.turnCount >= 0
  );
}

export function parseVibeSessionTree(raw: string): VibeSessionTreeSnapshot | null {
  if (!raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<VibeSessionTreeSnapshot>;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      typeof parsed.activeBranchId !== 'string' ||
      !parsed.branches ||
      typeof parsed.branches !== 'object' ||
      Array.isArray(parsed.branches) ||
      !Object.values(parsed.branches).every(isVibeBranchDescriptor)
    ) {
      return null;
    }
    return {
      activeBranchId: parsed.activeBranchId,
      branches: parsed.branches as Record<string, VibeBranchDescriptor>,
      headSeq:
        typeof parsed.headSeq === 'number' &&
        Number.isSafeInteger(parsed.headSeq) &&
        parsed.headSeq >= 0
          ? parsed.headSeq
          : -1,
    };
  } catch {
    return null;
  }
}

export function flattenVibeBranchRows(tree: VibeSessionTreeSnapshot): VibeBranchRow[] {
  const all = Object.values(tree.branches);
  const root = (Object.hasOwn(tree.branches, 'main') ? tree.branches.main : undefined) ??
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

  const childrenByParent = new Map<string, VibeBranchDescriptor[]>();
  for (const branch of all) {
    if (branch.parentBranchId === null) continue;
    const parentId = Object.hasOwn(tree.branches, branch.parentBranchId)
      ? branch.parentBranchId
      : root.id;
    const list = childrenByParent.get(parentId) ?? [];
    list.push(branch);
    childrenByParent.set(parentId, list);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.forkSeq - b.forkSeq || a.createdAt.localeCompare(b.createdAt));
  }

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

/**
 * Quotes a `/tree` argument the way the runtime tokenizer (`tokenizeTreeArgs`) reads it back:
 * double quotes with `\` and `"` escaped, as WebUI's `quoteTreeArg` does. Plain tokens stay
 * bare so the common case reads naturally; without quoting, `my spike` became the name `my`.
 */
export function quoteVibeTreeArg(value: string): string {
  if (value.length > 0 && !/[\s"'\\]/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
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
      return `new ${quoteVibeTreeArg(action.name.trim())}`;
    case 'switch':
      return `switch ${quoteVibeTreeArg(action.branchId)}${action.keepFiles ? ' --keep-files' : ''}`;
    case 'fold':
      return `fold ${quoteVibeTreeArg(action.branchId)}`;
  }
}
