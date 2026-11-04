import { ChevronDown, ChevronRight, FileCode2, Folder, FolderOpen } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { FileNode } from './file-model';
import { treeWindow, visibleTreeRows } from './file-tree-rows';

const ROW_HEIGHT = 29;

/**
 * Project directory tree that renders only the rows in view, so large projects
 * stay responsive. Keyboard movement works on row positions, not mounted nodes.
 */
export function FileTreeView({
  tree,
  expanded,
  active,
  selected,
  query,
  changes,
  prefix,
  onSelect,
  onContext,
}: {
  tree: FileNode[];
  expanded: string[];
  active: string;
  selected: string;
  query: string;
  changes: Record<string, unknown>[];
  prefix: string;
  onSelect: (node: FileNode) => void;
  onContext: (event: React.MouseEvent, path: string) => void;
}) {
  const { t } = useDesktopText();
  const rows = useMemo(
    () => visibleTreeRows(tree, new Set(expanded), query),
    [tree, expanded, query],
  );
  const statuses = useMemo(
    () => new Map(changes.map((file) => [String(file['path']), file['status']])),
    [changes],
  );
  const container = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 600 });
  const [focusPath, setFocusPath] = useState('');
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => setView({ top: element.scrollTop, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const { start, end } = treeWindow(rows.length, view.top, view.height, ROW_HEIGHT);
  // After keyboard movement, focus the target once it is mounted in the window.
  useEffect(() => {
    if (!focusPath) return;
    container.current
      ?.querySelector<HTMLButtonElement>(`[data-tree-path="${CSS.escape(focusPath)}"]`)
      ?.focus();
  }, [focusPath, start, end]);
  const moveTo = (index: number) => {
    const row = rows[Math.max(0, Math.min(rows.length - 1, index))];
    const element = container.current;
    if (!row || !element) return;
    const at = rows.indexOf(row) * ROW_HEIGHT;
    if (at < element.scrollTop) element.scrollTop = at;
    else if (at + ROW_HEIGHT > element.scrollTop + element.clientHeight)
      element.scrollTop = at + ROW_HEIGHT - element.clientHeight;
    setView({ top: element.scrollTop, height: element.clientHeight });
    setFocusPath(row.node.path);
  };
  return (
    <div
      ref={container}
      role="tree"
      aria-label={t('tree.label')}
      className="file-directory-tree"
      onScroll={(event) =>
        setView({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })
      }
      onKeyDown={(event) => {
        const path = (event.target as HTMLElement).getAttribute('data-tree-path');
        const index = rows.findIndex((row) => row.node.path === path);
        if (index < 0) return;
        const next =
          event.key === 'ArrowDown'
            ? index + 1
            : event.key === 'ArrowUp'
              ? index - 1
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? rows.length - 1
                  : null;
        if (next === null) return;
        event.preventDefault();
        moveTo(next);
      }}
    >
      <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
        {rows.slice(start, end).map(({ node, depth, open }, offset) => {
          const directory = node.type === 'directory';
          const status = statuses.get(prefix + node.path);
          return (
            <button
              type="button"
              role="treeitem"
              key={node.path}
              data-tree-path={node.path}
              aria-label={node.path}
              aria-level={depth + 1}
              aria-setsize={rows.length}
              aria-posinset={start + offset + 1}
              aria-selected={active === node.path || selected === node.path}
              {...(directory ? { 'aria-expanded': open } : {})}
              className={`file-tree-row ${active === node.path ? 'selected' : ''}`}
              style={{
                position: 'absolute',
                top: (start + offset) * ROW_HEIGHT,
                height: ROW_HEIGHT,
                paddingLeft: 12 + depth * 15,
              }}
              onClick={() => onSelect(node)}
              onContextMenu={(event) => onContext(event, node.path)}
              onKeyDown={(event) => {
                if (
                  directory &&
                  ((event.key === 'ArrowRight' && !open) || (event.key === 'ArrowLeft' && open))
                ) {
                  event.preventDefault();
                  onSelect(node);
                }
              }}
            >
              {directory ? (
                open ? (
                  <ChevronDown size={12} />
                ) : (
                  <ChevronRight size={12} />
                )
              ) : (
                <span className="file-tree-indent" />
              )}
              {directory ? (
                open ? (
                  <FolderOpen size={15} />
                ) : (
                  <Folder size={15} />
                )
              ) : (
                <FileCode2 size={14} />
              )}
              <span>{node.name}</span>
              {Boolean(status) && <b className="file-git-status">{String(status)}</b>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Reloads the tree when the engine reports that files under the project changed, as the WebUI's
 * explorer does on `files.tree.changed` (already coalesced by the engine's watcher). The value
 * seen when the workspace opened is skipped: the first read already reflects it.
 */
export function useTreeChanges(
  changed: unknown,
  refresh: () => Promise<void>,
  onError: (message: string) => void,
) {
  const opened = useRef(changed);
  useEffect(() => {
    if (!changed || changed === opened.current) return;
    const timer = window.setTimeout(
      () =>
        void refresh().catch((error: unknown) =>
          onError(String(error instanceof Error ? error.message : error)),
        ),
      250,
    );
    return () => window.clearTimeout(timer);
  }, [changed, refresh, onError]);
}
