import { memo } from 'react';
import type React from 'react';
import { ChevronRight, Folder, FolderOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAppTranslation } from '@/i18n';
import type { TreeNode } from '@/stores/file-store';
import { fileIcon, fileIconColor } from '@/lib/file-icons';
import { treeRowId } from './tree-helpers.js';

const GIT_STATUS_COLORS: Record<string, string> = {
  M: 'text-warning',
  A: 'text-success',
  D: 'text-destructive',
  R: 'text-info',
  C: 'text-info',
  U: 'text-destructive',
  '?': 'text-primary',
};

const GIT_STATUS_LABELS: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  U: 'Unmerged',
  '?': 'Untracked',
};

function GitStatusDot({ status }: { status: string }) {
  const letter = status[0] ?? '?';
  const color = GIT_STATUS_COLORS[letter] ?? 'text-muted-foreground';
  const label = GIT_STATUS_LABELS[letter] ?? 'Unknown';
  return (
    <span
      role="img"
      aria-label={label}
      className={cn('shrink-0 text-[8px] font-bold tabular-nums', color)}
      title={label}
    >
      {letter}
    </span>
  );
}

interface TreeRowProps {
  node: TreeNode;
  depth: number;
  emptyPlaceholder?: boolean | undefined;
  expanded: boolean;
  isActive: boolean;
  isSelected: boolean;
  isFocused: boolean;
  gitStatus?: string | undefined;
  onToggle: (path: string) => void;
  onSelect: (filePath: string) => void;
  onOpen: (filePath: string) => void;
  onContextMenu: (e: React.MouseEvent, node: TreeNode) => void;
}

export const TreeRow = memo(function TreeRow({
  node,
  depth,
  emptyPlaceholder,
  expanded,
  isActive,
  isSelected,
  isFocused,
  gitStatus,
  onToggle,
  onSelect,
  onOpen,
  onContextMenu,
}: TreeRowProps) {
  const { t } = useAppTranslation();

  if (emptyPlaceholder) {
    return (
      <div
        role="treeitem"
        aria-disabled="true"
        aria-level={depth + 1}
        className="text-[10px] text-muted-foreground italic py-0.5"
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        {t('activity:fileExplorer.emptyDir')}
      </div>
    );
  }

  if (node.type === 'directory') {
    const DirIcon = expanded ? FolderOpen : Folder;
    const dirColor = fileIconColor(node.name, true);
    return (
      <button
        type="button"
        id={treeRowId(node.path)}
        title={node.path}
        role="treeitem"
        aria-expanded={expanded}
        aria-level={depth + 1}
        tabIndex={-1}
        onClick={() => onToggle(node.path)}
        onContextMenu={(e) => onContextMenu(e, node)}
        className={cn(
          'flex items-center gap-1 w-full text-left px-1 py-0.5 text-[11px] rounded',
          'hover:bg-muted/60 transition-colors',
          isFocused && 'ring-1 ring-inset ring-primary/40 bg-muted/40',
        )}
        style={{ paddingLeft: `${depth * 14 + 4}px` }}
      >
        <ChevronRight
          className={cn(
            'h-3 w-3 shrink-0 text-muted-foreground transition-transform',
            expanded && 'rotate-90',
          )}
        />
        <DirIcon className={cn('h-3.5 w-3.5 shrink-0', dirColor)} />
        <span
          className={cn(
            'truncate font-medium flex-1 min-w-0',
            gitStatus === 'M' && 'text-warning/80',
          )}
        >
          {node.name}
        </span>
        {gitStatus && <GitStatusDot status={gitStatus} />}
      </button>
    );
  }

  const Icon = fileIcon(node.name);
  const iconColor = fileIconColor(node.name, false);
  return (
    <button
      type="button"
      id={treeRowId(node.path)}
      title={node.path}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={isActive || isSelected}
      tabIndex={-1}
      onClick={() => onSelect(node.path)}
      onContextMenu={(e) => onContextMenu(e, node)}
      onDoubleClick={(e) => {
        e.preventDefault();
        onOpen(node.path);
      }}
      className={cn(
        'flex items-center gap-1.5 w-full text-left px-1 py-0.5 text-[11px] rounded',
        'hover:bg-muted/60 transition-colors',
        isActive && 'bg-primary/10 text-primary',
        isSelected && !isActive && 'bg-muted/70 ring-1 ring-inset ring-border',
        isFocused && !isActive && !isSelected && 'ring-1 ring-inset ring-primary/40 bg-muted/40',
      )}
      style={{ paddingLeft: `${depth * 14 + 4}px` }}
    >
      <span className="w-3 shrink-0" />
      <Icon className={cn('h-3.5 w-3.5 shrink-0', iconColor)} />
      <span
        className={cn(
          'truncate flex-1 min-w-0',
          !isActive && gitStatus === 'M' && 'text-warning/90',
          !isActive && (gitStatus === 'A' || gitStatus === '?') && 'text-success/90',
          gitStatus === 'D' && 'line-through opacity-70 text-destructive/90',
        )}
      >
        {node.name}
      </span>
      {gitStatus && <GitStatusDot status={gitStatus} />}
    </button>
  );
});
