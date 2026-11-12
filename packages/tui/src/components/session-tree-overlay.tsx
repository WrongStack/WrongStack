import type { SessionBranchDescriptor, SessionTreeSnapshot } from '@wrongstack/contracts/types';
import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { useWindowedPicker } from '../hooks/use-windowed-picker.js';
import { Box, Text, useInput } from '../ink.js';
import { isLeakedMouseInput } from '../mouse.js';

export interface SessionTreeOverlayRow {
  branch: SessionBranchDescriptor;
  depth: number;
  treePrefix: string;
  glyph: string;
  isActive: boolean;
  casShortHash?: string | undefined;
}

export interface SessionTreeOverlayProps {
  tree: SessionTreeSnapshot;
  maxRows?: number | undefined;
  interactive?: boolean | undefined;
  busy?: boolean | undefined;
  statusMessage?: string | undefined;
  selectedIndex?: number | undefined;
  onSelectIndex?: ((index: number) => void) | undefined;
  onSwitch?: ((branch: SessionBranchDescriptor, opts: { keepFiles: boolean }) => void) | undefined;
  onCreateBranch?: ((name: string, fromBranch: SessionBranchDescriptor) => void) | undefined;
  onFold?: ((branch: SessionBranchDescriptor) => void) | undefined;
  onArchive?: ((branch: SessionBranchDescriptor) => void) | undefined;
  onClose?: (() => void) | undefined;
}

function branchGlyph(branch: SessionBranchDescriptor, isActive: boolean): string {
  if (isActive) return '●';
  if (branch.status === 'folded') return '◈';
  if (branch.status === 'archived') return '✕';
  return '○';
}

/**
 * Flatten a `SessionTreeSnapshot` into pre-order visual tree rows with Unicode
 * box-drawing connectors (`├─ `, `└─ `, `│  `).
 */
export function flattenSessionTreeRows(tree: SessionTreeSnapshot): SessionTreeOverlayRow[] {
  const all = Object.values(tree.branches);
  const childrenMap = new Map<string, SessionBranchDescriptor[]>();
  for (const branch of all) {
    if (branch.parentBranchId === null) continue;
    const parentId = tree.branches[branch.parentBranchId] ? branch.parentBranchId : 'main';
    const siblings = childrenMap.get(parentId) ?? [];
    siblings.push(branch);
    childrenMap.set(parentId, siblings);
  }
  for (const siblings of childrenMap.values()) {
    siblings.sort((a, b) => a.forkSeq - b.forkSeq || a.createdAt.localeCompare(b.createdAt));
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

  const rows: SessionTreeOverlayRow[] = [];
  const visited = new Set<string>();

  const pushRow = (branch: SessionBranchDescriptor, depth: number, treePrefix: string): void => {
    const isActive = branch.id === tree.activeBranchId;
    const fullHash =
      branch.latestWorkspaceCheckpoint?.manifestHash ??
      branch.baseWorkspaceCheckpoint?.manifestHash;
    rows.push({
      branch,
      depth,
      treePrefix,
      glyph: branchGlyph(branch, isActive),
      isActive,
      ...(fullHash ? { casShortHash: fullHash.slice(0, 8) } : {}),
    });
  };

  visited.add(root.id);
  pushRow(root, 0, '');

  const walk = (parentId: string, depth: number, indent: string): void => {
    const kids = childrenMap.get(parentId) ?? [];
    for (let i = 0; i < kids.length; i += 1) {
      const child = kids[i]!;
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      const isLast = i === kids.length - 1;
      const connector = isLast ? '└─ ' : '├─ ';
      pushRow(child, depth, `${indent}${connector}`);
      walk(child.id, depth + 1, `${indent}${isLast ? '   ' : '│  '}`);
    }
  };

  walk(root.id, 1, '');
  return rows;
}

export function SessionTreeOverlay({
  tree,
  maxRows,
  interactive = true,
  busy = false,
  statusMessage,
  selectedIndex,
  onSelectIndex,
  onSwitch,
  onCreateBranch,
  onFold,
  onArchive,
  onClose,
}: SessionTreeOverlayProps): React.ReactElement {
  const rows = useMemo(() => flattenSessionTreeRows(tree), [tree]);
  const activeIdx = useMemo(() => {
    const idx = rows.findIndex((r) => r.isActive);
    return Math.max(idx, 0);
  }, [rows]);

  const [internalIndex, setInternalIndex] = useState<number>(activeIdx);
  const [showDetails, setShowDetails] = useState<boolean>(false);
  const [creatingBranch, setCreatingBranch] = useState<boolean>(false);
  const [draftBranchName, setDraftBranchName] = useState<string>('');

  useEffect(() => {
    if (selectedIndex === undefined) {
      setInternalIndex((prev) => (prev >= 0 && prev < rows.length ? prev : activeIdx));
    }
  }, [activeIdx, rows.length, selectedIndex]);

  const currentIndex =
    rows.length === 0 ? 0 : Math.max(0, Math.min(selectedIndex ?? internalIndex, rows.length - 1));

  const updateSelection = (next: number): void => {
    if (rows.length === 0) return;
    const clamped = Math.max(0, Math.min(next, rows.length - 1));
    if (selectedIndex === undefined) setInternalIndex(clamped);
    onSelectIndex?.(clamped);
  };

  useInput(
    (input, key) => {
      if (input && isLeakedMouseInput(input)) return;
      if (creatingBranch) {
        if (key.escape) {
          setCreatingBranch(false);
          setDraftBranchName('');
          return;
        }
        if (key.return) {
          const trimmed = draftBranchName.trim();
          const selectedRow = rows[currentIndex];
          if (trimmed && selectedRow) {
            setCreatingBranch(false);
            setDraftBranchName('');
            onCreateBranch?.(trimmed, selectedRow.branch);
          }
          return;
        }
        if (key.backspace || key.delete) {
          setDraftBranchName((prev) => prev.slice(0, -1));
          return;
        }
        if (input && !key.ctrl && !key.meta && /^[a-zA-Z0-9._-]+$/.test(input)) {
          setDraftBranchName((prev) => (prev + input).slice(0, 64));
        }
        return;
      }

      if (key.escape || input === 'q') {
        onClose?.();
        return;
      }
      if (busy || rows.length === 0) return;

      if (key.upArrow || input === 'k') {
        updateSelection(currentIndex > 0 ? currentIndex - 1 : rows.length - 1);
        return;
      }
      if (key.downArrow || input === 'j') {
        updateSelection(currentIndex < rows.length - 1 ? currentIndex + 1 : 0);
        return;
      }

      const selectedRow = rows[currentIndex];
      if (!selectedRow) return;

      if (key.leftArrow || input === 'h') {
        const parentId = selectedRow.branch.parentBranchId;
        if (parentId) {
          const parentIdx = rows.findIndex((r) => r.branch.id === parentId);
          if (parentIdx >= 0) updateSelection(parentIdx);
        }
        return;
      }

      if (key.rightArrow || input === 'l') {
        const firstChildIdx = rows.findIndex(
          (r) => r.branch.parentBranchId === selectedRow.branch.id,
        );
        if (firstChildIdx >= 0) {
          updateSelection(firstChildIdx);
          return;
        }
        const siblingIndices = rows
          .map((r, idx) => ({ r, idx }))
          .filter(({ r }) => r.branch.parentBranchId === selectedRow.branch.parentBranchId)
          .map(({ idx }) => idx);
        if (siblingIndices.length > 1) {
          const pos = siblingIndices.indexOf(currentIndex);
          const nextSiblingIdx = siblingIndices[(pos + 1) % siblingIndices.length];
          if (nextSiblingIdx !== undefined) updateSelection(nextSiblingIdx);
        }
        return;
      }

      if (key.return) {
        onSwitch?.(selectedRow.branch, { keepFiles: false });
        return;
      }
      if (input === 's') {
        onSwitch?.(selectedRow.branch, { keepFiles: true });
        return;
      }
      if (input === 'b' && onCreateBranch) {
        setCreatingBranch(true);
        setDraftBranchName(`spike-${rows.length}`);
        return;
      }
      if (input === 'd') {
        setShowDetails((prev) => !prev);
        return;
      }
      if (input === 'f' && selectedRow.branch.id !== 'main') {
        onFold?.(selectedRow.branch);
        return;
      }
      if (input === 'a' && selectedRow.branch.id !== 'main' && !selectedRow.isActive) {
        onArchive?.(selectedRow.branch);
      }
    },
    { isActive: interactive },
  );

  const { start, end } = useWindowedPicker({
    total: rows.length,
    selected: currentIndex,
    maxRows,
    chromeRows: 7,
    markerRows: 2,
  });

  const visibleRows = rows.slice(start, end);
  const aboveCount = start;
  const belowCount = Math.max(0, rows.length - end);
  const focusedRow = rows[currentIndex];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box flexDirection="column">
        <Text bold color="cyan">
          Session Tree ({rows.length} {rows.length === 1 ? 'branch' : 'branches'})
        </Text>
        <Text dimColor wrap="truncate-end">
          ↑/↓/←/→ nav · Enter switch · s keep-files · b branch · f fold · d details · a archive ·
          Esc close
        </Text>
      </Box>

      {aboveCount > 0 ? <Text dimColor>↑ {aboveCount} more above</Text> : null}

      <Box flexDirection="column" marginTop={0}>
        {visibleRows.map((row, offset) => {
          const absoluteIdx = start + offset;
          const isSelected = absoluteIdx === currentIndex;
          const statusColor = row.isActive
            ? 'green'
            : row.branch.status === 'folded'
              ? 'magenta'
              : row.branch.status === 'archived'
                ? 'gray'
                : undefined;
          const cursor = isSelected ? '❯ ' : '  ';
          const turnsText = `${row.branch.turnCount} turn${row.branch.turnCount === 1 ? '' : 's'}`;
          const intoName = row.branch.foldedIntoBranchId
            ? (tree.branches[row.branch.foldedIntoBranchId]?.name ?? row.branch.foldedIntoBranchId)
            : 'main';

          return (
            <Box key={row.branch.id}>
              <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
                {cursor}
                {row.treePrefix}
              </Text>
              <Text color={statusColor} bold={row.isActive || isSelected}>
                {row.glyph} {row.branch.name}
              </Text>
              <Text dimColor> ({turnsText})</Text>
              {row.isActive ? <Text color="green"> [ACTIVE]</Text> : null}
              {row.branch.status === 'folded' ? (
                <Text color="magenta"> [folded → {intoName}]</Text>
              ) : null}
              {row.branch.status === 'archived' ? <Text color="gray"> [archived]</Text> : null}
              {row.branch.forkPromptIndex !== undefined ? (
                <Text dimColor> @p{row.branch.forkPromptIndex}</Text>
              ) : null}
              {row.casShortHash ? <Text color="yellow"> cas:{row.casShortHash}</Text> : null}
            </Box>
          );
        })}
      </Box>

      {belowCount > 0 ? <Text dimColor>↓ {belowCount} more below</Text> : null}

      {creatingBranch && focusedRow ? (
        <Box marginTop={1}>
          <Text color="cyan" bold>
            New branch from {focusedRow.branch.name}:{' '}
          </Text>
          <Text>{draftBranchName}█</Text>
          <Text dimColor> (Enter create · Esc cancel)</Text>
        </Box>
      ) : null}

      {focusedRow ? (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>
            id:{focusedRow.branch.id} · status:{focusedRow.branch.status} · forkSeq:
            {focusedRow.branch.forkSeq}
            {focusedRow.branch.parentBranchId
              ? ` · parent:${tree.branches[focusedRow.branch.parentBranchId]?.name ?? focusedRow.branch.parentBranchId}`
              : ' · root'}
            {focusedRow.branch.label ? ` · "${focusedRow.branch.label}"` : ''}
          </Text>
          {showDetails ? (
            <Box flexDirection="column">
              <Text dimColor>
                fork:{' '}
                {focusedRow.branch.forkPromptIndex !== undefined
                  ? `prompt #${focusedRow.branch.forkPromptIndex}`
                  : `seq ${focusedRow.branch.forkSeq}`}{' '}
                · baseCas:
                {focusedRow.branch.baseWorkspaceCheckpoint?.manifestHash.slice(0, 12) ?? 'none'} (
                {focusedRow.branch.baseWorkspaceCheckpoint?.entryCount ?? 0} files) · headCas:
                {focusedRow.branch.latestWorkspaceCheckpoint?.manifestHash.slice(0, 12) ?? 'none'} (
                {focusedRow.branch.latestWorkspaceCheckpoint?.entryCount ?? 0} files)
              </Text>
              {focusedRow.branch.baseWorkspaceCheckpoint &&
              focusedRow.branch.latestWorkspaceCheckpoint ? (
                <Text
                  color={
                    focusedRow.branch.baseWorkspaceCheckpoint.manifestHash !==
                    focusedRow.branch.latestWorkspaceCheckpoint.manifestHash
                      ? 'yellow'
                      : 'green'
                  }
                >
                  workspace:{' '}
                  {focusedRow.branch.baseWorkspaceCheckpoint.manifestHash !==
                  focusedRow.branch.latestWorkspaceCheckpoint.manifestHash
                    ? 'diverged from fork checkpoint'
                    : 'matches fork checkpoint'}
                </Text>
              ) : null}
            </Box>
          ) : null}
        </Box>
      ) : null}

      {statusMessage ? (
        <Box>
          <Text color={busy ? 'yellow' : 'cyan'}>{statusMessage}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
