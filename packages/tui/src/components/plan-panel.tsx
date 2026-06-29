import { Box, Text, useInput } from '../ink.js';
import type React from 'react';
import { useEffect, useState } from 'react';
import { theme } from '../theme.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveWstackPaths, sessionScopedPath } from '@wrongstack/core/utils';

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

function planFilePath(projectRoot: string, sessionId: string | null, scope: 'session' | 'project'): string {
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
export function PlanPanel({ projectRoot, sessionId, onClose: _onClose }: PlanPanelProps): React.ReactElement {
  void _onClose; // invoked by the app-level keyboard handler, not here
  const [items, setItems] = useState<PlanItem[]>([]);
  const [title, setTitle] = useState<string | undefined>(undefined);
  const [scope, setScope] = useState<'session' | 'project'>('session');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load(scope_: 'session' | 'project') {
    setLoading(true);
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
        setScope(scope_);
        setLoading(false);
        return;
      }
      const parsed: PlanFile = JSON.parse(content);
      setItems(parsed.items ?? []);
      setTitle(parsed.title);
      setScope(scope_);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load('session');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-load when scope changes
  async function handleScopeSwitch(newScope: 'session' | 'project') {
    await load(newScope);
  }

  useInput((input) => {
    if (input === 's' || input === 'S') {
      void handleScopeSwitch(scope === 'session' ? 'project' : 'session');
    }
  });

  const open = items.filter((i) => i.status === 'open');
  const inProgress = items.filter((i) => i.status === 'in_progress');
  const done = items.filter((i) => i.status === 'done');

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      {/* Header */}
      <Box flexDirection="row" gap={1} marginBottom={1}>
        <Text bold color="cyan">📋 PLAN</Text>
        <Text dimColor>│</Text>
        <Text dimColor>
          {scope === 'session' ? (
            <Text dimColor>session-scoped</Text>
          ) : (
            <Text color="yellow">project-scoped</Text>
          )}
        </Text>
        <Text dimColor>│</Text>
        <Text dimColor>
          {items.length} item{items.length !== 1 ? 's' : ''}
        </Text>
        {title ? (
          <>
            <Text dimColor>│</Text>
            <Text dimColor>{title}</Text>
          </>
        ) : null}
        <Text dimColor>│ F5/Esc to close</Text>
      </Box>

      {/* Loading / error / empty */}
      {loading ? (
        <Text dimColor>Loading plan...</Text>
      ) : error ? (
        <Text color="red">Error: {error}</Text>
      ) : items.length === 0 ? (
        <Box flexDirection="column" gap={0}>
          <Text dimColor>No plan items yet.</Text>
          <Text dimColor>
            Use <Text color={theme.accent}>/plan add &lt;title&gt;</Text> to create one.
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" gap={0}>
          {/* In-progress section */}
          {inProgress.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              <Text color="yellow" bold>
                In Progress ({inProgress.length})
              </Text>
              {inProgress.map((item) => (
                <PlanRow key={item.id} item={item} />
              ))}
            </Box>
          )}

          {/* Open section */}
          {open.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              <Text dimColor bold>
                Open ({open.length})
              </Text>
              {open.map((item) => (
                <PlanRow key={item.id} item={item} />
              ))}
            </Box>
          )}

          {/* Done section */}
          {done.length > 0 && (
            <Box flexDirection="column">
              <Text color="green" bold>
                Done ({done.length})
              </Text>
              {done.map((item) => (
                <PlanRow key={item.id} item={item} />
              ))}
            </Box>
          )}
        </Box>
      )}

      {/* Footer hints */}
      <Box marginTop={1}>
        <Text dimColor>
          [<Text color="cyan">S</Text>] Switch scope to{' '}
          {scope === 'session' ? (
            <Text color="yellow">project</Text>
          ) : (
            <Text color="cyan">session</Text>
          )}{' '}
          · Use <Text color={theme.accent}>/plan add</Text> to add items ·{' '}
          <Text dimColor>F5/Esc to close</Text>
        </Text>
      </Box>
    </Box>
  );
}

function PlanRow({ item }: { item: PlanItem }): React.ReactElement {
  const icon = STATUS_ICON[item.status] ?? '?';
  const color = STATUS_COLOR[item.status] ?? 'white';
  return (
    <Box flexDirection="row" gap={1}>
      <Text color={color}>{icon}</Text>
      <Text color={color}>{item.title}</Text>
      {item.details ? (
        <Text dimColor> — {item.details.slice(0, 60)}{item.details.length > 60 ? '…' : ''}</Text>
      ) : null}
    </Box>
  );
}
