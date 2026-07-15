import { Box, Text, useInput } from '../ink.js';
import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { theme } from '../theme.js';
import { glyphs } from '../ui-glyphs.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveWstackPaths, sessionScopedPath } from '@wrongstack/core/utils';
import {
  EmptyPanelState,
  KeyCap,
  MonitorShell,
  panelWindow,
  truncatePanelText,
  useMonitorSize,
} from './monitor-shell.js';
import { renderProgress } from './status-bar.js';

interface PlanItem {
  id: string;
  title: string;
  details?: string;
  status: 'open' | 'in_progress' | 'done';
  createdAt: string;
  updatedAt: string;
}

interface PlanFile {
  version: 1;
  sessionId: string;
  title?: string;
  updatedAt: string;
  items: PlanItem[];
}

export interface PlanPanelProps {
  /** Absolute path to the project root. */
  projectRoot: string;
  /** Current session ID (null if no active session). */
  sessionId: string | null;
  /** Called when the user presses F5 / Esc to close. */
  onClose: () => void;
}

const STATUS_COLOR: Record<string, string> = {
  open: 'gray',
  in_progress: 'yellow',
  done: 'green',
};

const STATUS_ICON: Record<string, string> = {
  open: '○',
  in_progress: '◐',
  done: '✓',
};

function planFilePath(
  projectRoot: string,
  sessionId: string | null,
  scope: 'session' | 'project',
): string {
  // Resolve the SAME location the /plan tool writes to — the global per-project
  // sessions dir (~/.wrongstack/projects/<slug>/sessions), NOT the repo-local
  // <root>/.wrongstack/sessions. The two never coincide, so the old repo-local
  // path always read a non-existent file and the panel showed an empty plan.
  const base = resolveWstackPaths({ projectRoot }).projectSessions;
  if (scope === 'project') {
    return path.join(base, 'backlog.plan.json');
  }
  // Session scope — use sessionId if available, otherwise fall back to project
  if (sessionId) {
    return sessionScopedPath(base, sessionId, '.plan.json');
  }
  return path.join(base, 'backlog.plan.json');
}

/**
 * Full-screen plan panel (F5 in TUI).
 *
 * Reads the active plan JSON file from disk and renders plan items grouped by status.
 * Shows the current scope and a hint for switching scopes via the /plan tool.
 */
export function PlanPanel({
  projectRoot,
  sessionId,
  onClose: _onClose,
}: PlanPanelProps): React.ReactElement {
  void _onClose; // invoked by the app-level keyboard handler, not here
  const size = useMonitorSize();
  const [items, setItems] = useState<PlanItem[]>([]);
  const [title, setTitle] = useState<string | undefined>(undefined);
  const [scope, setScope] = useState<'session' | 'project'>('session');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<string | undefined>(undefined);

  const load = useCallback(
    async (scope_: 'session' | 'project', quiet = false) => {
      if (!quiet) setLoading(true);
      setError(null);
      try {
        const filePath = planFilePath(projectRoot, sessionId, scope_);
        let content: string;
        try {
          content = await fs.readFile(filePath, 'utf-8');
        } catch {
          // File doesn't exist yet
          setItems([]);
          setTitle(undefined);
          setUpdatedAt(undefined);
          setScope(scope_);
          setLoading(false);
          return;
        }
        const parsed: PlanFile = JSON.parse(content);
        setItems(parsed.items ?? []);
        setTitle(parsed.title);
        setUpdatedAt(parsed.updatedAt);
        setScope(scope_);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [projectRoot, sessionId],
  );

  useEffect(() => {
    void load(scope);
    const timer = setInterval(() => void load(scope, true), 3000);
    return () => clearInterval(timer);
  }, [load, scope]);

  // Re-load when scope changes
  async function handleScopeSwitch(newScope: 'session' | 'project') {
    await load(newScope);
  }

  useInput((input, key) => {
    if (input === 's' || input === 'S') {
      void handleScopeSwitch(scope === 'session' ? 'project' : 'session');
    } else if (key.upArrow) {
      setSelected((value) => Math.max(0, value - 1));
    } else if (key.downArrow) {
      setSelected((value) => Math.min(Math.max(0, items.length - 1), value + 1));
    }
  });

  const open = items.filter((i) => i.status === 'open');
  const inProgress = items.filter((i) => i.status === 'in_progress');
  const done = items.filter((i) => i.status === 'done');
  const ordered = useMemo(() => [...inProgress, ...open, ...done], [inProgress, open, done]);
  useEffect(() => {
    setSelected((value) => Math.min(Math.max(0, ordered.length - 1), value));
  }, [ordered.length]);
  const limit = Math.max(2, size.contentRows - 5);
  const window = panelWindow(ordered.length, selected, limit);
  const visible = ordered.slice(window.start, window.end);
  const selectedItem = ordered[selected];
  const completeRatio = items.length > 0 ? done.length / items.length : 0;

  return (
    <MonitorShell
      accent={theme.accent}
      icon={glyphs.plan}
      title="PLAN"
      kicker={size.columns >= 90 ? truncatePanelText(title ?? 'execution map', 30) : undefined}
      right={
        <Text color={scope === 'project' ? theme.warn : theme.accent} bold>
          {scope.toUpperCase()} {items.length} items
        </Text>
      }
      footer={
        <Box gap={2}>
          <KeyCap keyName="↑↓" label="inspect" color={theme.accent} />
          <KeyCap
            keyName="S"
            label={`switch to ${scope === 'session' ? 'project' : 'session'}`}
            color={theme.accent}
          />
          <KeyCap keyName="F5" label="close" color={theme.accent} />
        </Box>
      }
    >
      <Box marginTop={1} gap={1}>
        <Text color={theme.textMuted}>PROGRESS</Text>
        <Text color={completeRatio === 1 && items.length > 0 ? theme.success : theme.accent}>
          [{renderProgress(completeRatio, size.columns >= 90 ? 18 : 10)}]
        </Text>
        <Text color={theme.textSecondary}>
          {done.length}/{items.length}
        </Text>
        <Text color={theme.warn}> ◐ {inProgress.length}</Text>
        <Text color={theme.textMuted}> ○ {open.length}</Text>
        {updatedAt && size.columns >= 105 ? (
          <Text color={theme.textMuted}> updated {new Date(updatedAt).toLocaleTimeString()}</Text>
        ) : null}
      </Box>

      {/* Loading / error / empty */}
      {loading ? (
        <Text color={theme.textMuted}>Loading plan…</Text>
      ) : error ? (
        <Text color={theme.error}>Could not read plan: {error}</Text>
      ) : items.length === 0 ? (
        <EmptyPanelState
          icon="◇"
          title="No plan items yet"
          detail="Use /plan add <title> to create the first step."
          accent={theme.accent}
        />
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {selectedItem?.details ? (
            <Text color={theme.textMuted}>
              DETAIL {truncatePanelText(selectedItem.details, size.contentWidth - 8)}
            </Text>
          ) : null}
          {window.above > 0 ? (
            <Text color={theme.textMuted}> ↑ {window.above} earlier items</Text>
          ) : null}
          {visible.map((item, index) => (
            <PlanRow
              key={item.id}
              item={item}
              selected={window.start + index === selected}
              width={size.contentWidth}
            />
          ))}
          {window.below > 0 ? (
            <Text color={theme.textMuted}> ↓ {window.below} more items</Text>
          ) : null}
        </Box>
      )}
    </MonitorShell>
  );
}

function PlanRow({
  item,
  selected,
  width,
}: {
  item: PlanItem;
  selected: boolean;
  width: number;
}): React.ReactElement {
  const icon = STATUS_ICON[item.status] ?? '?';
  const color = STATUS_COLOR[item.status] ?? 'white';
  return (
    <Box flexDirection="row">
      <Text color={selected ? theme.accent : theme.textMuted}>{selected ? '›' : ' '} </Text>
      <Text color={color} bold={selected}>
        {icon}{' '}
      </Text>
      <Text
        color={
          selected
            ? theme.textPrimary
            : item.status === 'done'
              ? theme.textMuted
              : theme.textSecondary
        }
        bold={selected}
      >
        {truncatePanelText(item.title, Math.max(12, width - 20))}
      </Text>
      <Box flexGrow={1} />
      <Text color={color}>{item.status.replace('_', ' ')}</Text>
    </Box>
  );
}
