import type {
  SessionBranchDescriptor,
  SessionTreeSnapshot,
} from '@wrongstack/contracts/types/session';
import { Check, ChevronDown, GitBranch, GitMerge, Plus } from 'lucide-react';
import type React from 'react';
import { useMemo, useState } from 'react';

export interface SessionBranchRow {
  branch: SessionBranchDescriptor;
  depth: number;
  isActive: boolean;
}

export function flattenSessionBranchRows(tree: SessionTreeSnapshot): SessionBranchRow[] {
  const all = Object.values(tree.branches);
  const childrenByParent = new Map<string, SessionBranchDescriptor[]>();
  for (const b of all) {
    if (b.parentBranchId === null) continue;
    const parentId = tree.branches[b.parentBranchId] ? b.parentBranchId : 'main';
    const list = childrenByParent.get(parentId) ?? [];
    list.push(b);
    childrenByParent.set(parentId, list);
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.forkSeq - b.forkSeq || a.createdAt.localeCompare(b.createdAt));
  }

  const root = tree.branches['main'] ??
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

  const rows: SessionBranchRow[] = [];
  const visited = new Set<string>();
  const walk = (branch: SessionBranchDescriptor, depth: number) => {
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

export interface SessionBranchPillProps {
  tree: SessionTreeSnapshot | null;
  busy?: boolean | undefined;
  onRefresh?: (() => void) | undefined;
  onCreateBranch?: ((name: string) => void | Promise<void>) | undefined;
  onSwitchBranch?:
    | ((branchId: string, opts?: { keepFiles?: boolean }) => void | Promise<void>)
    | undefined;
  onFoldBranch?: ((sourceBranchId: string) => void | Promise<void>) | undefined;
}

export function SessionBranchPill({
  tree,
  busy = false,
  onRefresh,
  onCreateBranch,
  onSwitchBranch,
  onFoldBranch,
}: SessionBranchPillProps): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [newBranchName, setNewBranchName] = useState('');
  const [keepFiles, setKeepFiles] = useState(false);

  const rows = useMemo(() => (tree ? flattenSessionBranchRows(tree) : []), [tree]);
  if (!tree) return null;

  const activeBranch = tree.branches[tree.activeBranchId];
  const activeName = activeBranch?.name ?? tree.activeBranchId ?? 'main';
  const branchCount = rows.length;

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = newBranchName.trim();
    if (!trimmed || !onCreateBranch) return;
    setNewBranchName('');
    void Promise.resolve(onCreateBranch(trimmed)).finally(() => {
      onRefresh?.();
    });
  };

  return (
    <div className="relative shrink-0" data-testid="session-branch-pill">
      <button
        type="button"
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) onRefresh?.();
        }}
        disabled={busy}
        className="inline-flex items-center gap-1 rounded-md border border-border/70 bg-muted/35 px-1.5 py-0.5 text-[11px] font-medium text-foreground/85 hover:bg-muted/70 transition-colors tabular-nums"
        title={`Session branch: ${activeName} (${branchCount} total)`}
      >
        <GitBranch className="h-3 w-3 text-primary shrink-0" />
        <span className="truncate max-w-[7rem]">{activeName}</span>
        {branchCount > 1 ? (
          <span className="rounded bg-primary/15 px-1 text-[10px] text-primary">{branchCount}</span>
        ) : null}
        <ChevronDown className="h-2.5 w-2.5 text-muted-foreground shrink-0" />
      </button>

      {open ? (
        <div className="absolute left-0 top-full mt-1 z-40 w-80 rounded-md border border-border/80 bg-popover p-2 shadow-lg space-y-2">
          <div className="flex items-center justify-between border-b border-border/60 pb-1.5">
            <span className="text-[11px] font-semibold">
              Session Tree ({branchCount} {branchCount === 1 ? 'branch' : 'branches'})
            </span>
            <label className="flex items-center gap-1 text-[10px] text-muted-foreground cursor-pointer">
              <input
                type="checkbox"
                checked={keepFiles}
                onChange={(e) => setKeepFiles(e.target.checked)}
                className="h-3 w-3"
              />
              Keep files on switch
            </label>
          </div>

          <div className="max-h-52 overflow-y-auto space-y-1">
            {rows.map(({ branch, depth, isActive }) => (
              <div
                key={branch.id}
                style={{ paddingLeft: `${Math.min(4, depth) * 12}px` }}
                className={`flex items-center justify-between gap-1.5 rounded px-1.5 py-1 text-xs ${
                  isActive ? 'bg-primary/10 font-medium' : 'hover:bg-accent/60'
                }`}
              >
                <button
                  type="button"
                  disabled={busy || isActive}
                  onClick={() => {
                    if (!onSwitchBranch || isActive) return;
                    setOpen(false);
                    void Promise.resolve(onSwitchBranch(branch.id, { keepFiles })).finally(() => {
                      onRefresh?.();
                    });
                  }}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
                >
                  {isActive ? (
                    <Check className="h-3 w-3 text-primary shrink-0" />
                  ) : (
                    <span className="h-3 w-3 shrink-0 text-center text-[10px] text-muted-foreground">
                      {branch.status === 'folded' ? '◈' : branch.status === 'archived' ? '✕' : '○'}
                    </span>
                  )}
                  <span className="truncate">{branch.name}</span>
                  <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                    {branch.turnCount}t
                  </span>
                </button>

                {branch.parentBranchId !== null && branch.status === 'active' && onFoldBranch ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setOpen(false);
                      void Promise.resolve(onFoldBranch(branch.id)).finally(() => {
                        onRefresh?.();
                      });
                    }}
                    title={`Fold "${branch.name}" summary into parent`}
                    className="inline-flex items-center gap-0.5 rounded border border-border/70 px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground hover:bg-muted"
                  >
                    <GitMerge className="h-2.5 w-2.5" />
                    <span>Fold</span>
                  </button>
                ) : null}
              </div>
            ))}
          </div>

          {onCreateBranch ? (
            <form
              onSubmit={handleCreate}
              className="flex items-center gap-1 pt-1 border-t border-border/60"
            >
              <input
                type="text"
                value={newBranchName}
                onChange={(e) => setNewBranchName(e.target.value)}
                placeholder="New branch name…"
                className="h-6 flex-1 rounded border border-border/70 bg-background px-2 text-[11px] outline-none focus:border-primary"
              />
              <button
                type="submit"
                disabled={busy || !newBranchName.trim()}
                className="inline-flex h-6 items-center gap-1 rounded bg-primary px-2 text-[10px] font-medium text-primary-foreground disabled:opacity-50"
              >
                <Plus className="h-3 w-3" />
                Branch
              </button>
            </form>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
