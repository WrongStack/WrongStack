import {
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  ListChecks,
  LoaderCircle,
  Map as MapIcon,
  PanelRight,
  Workflow,
  Wrench,
  X,
} from 'lucide-react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type {
  PlanStatus,
  TaskStatus,
  TodoStatus,
  WorklistStore,
  WorklistView,
} from './lib/worklist-store.js';
import { onOpenWorkspacePanel } from './lib/panel-events.js';
import type { ToolCallInfo } from './types.js';

const LazyWorklistSidebar = lazy(() =>
  import('./worklist-sidebar.js').then((module) => ({ default: module.WorklistSidebar })),
);

type SidebarView = 'tools' | WorklistView;

interface ToolSidebarProps {
  agentId: string;
  agentName: string;
  calls: ToolCallInfo[];
  worklists?: WorklistStore | undefined;
  requestWorklist?: ((view: WorklistView) => void) | undefined;
  onTodoStatusChange?: ((id: string, status: TodoStatus) => void) | undefined;
  onTaskStatusChange?: ((id: string, status: TaskStatus) => void) | undefined;
  onPlanStatusChange?: ((id: string, status: PlanStatus) => void) | undefined;
}

const EMPTY_WORKLISTS: ReturnType<WorklistStore['getSnapshot']> = {
  sessionId: null,
  todos: [],
  tasks: [],
  planItems: [],
  workbench: null,
};

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Tool names that are "meta" — task/plan/orchestration tools we show as
 *  compact status entries rather than full expandable calls. */
const META_TOOLS = new Set([
  'todo',
  'task',
  'plan',
  'delegate',
  'spawn_subagent',
  'kanban',
  'context_manager',
]);

export function ToolSidebar({
  agentId,
  agentName,
  calls,
  worklists,
  requestWorklist,
  onTodoStatusChange = () => undefined,
  onTaskStatusChange = () => undefined,
  onPlanStatusChange = () => undefined,
}: ToolSidebarProps) {
  const [view, setView] = useState<SidebarView | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const requested = useRef(new Set<WorklistView>());
  const subscribe = worklists?.subscribe ?? (() => () => undefined);
  const getSnapshot = worklists?.getSnapshot ?? (() => EMPTY_WORKLISTS);
  const worklistSnapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // Derive counts/splits only when their inputs change — this component
  // re-renders on every parent stream delta, and these are ~6 full-array passes.
  const runningCount = useMemo(
    () => calls.filter((call) => call.status === 'running').length,
    [calls],
  );
  const worklistCounts: Record<WorklistView, number> = useMemo(
    () => ({
      flow: worklistSnapshot.workbench?.totals.active ?? 0,
      todos: worklistSnapshot.todos.filter((item) => item.status !== 'completed').length,
      tasks: worklistSnapshot.tasks.filter((item) => item.status !== 'completed').length,
      plan: worklistSnapshot.planItems.filter((item) => item.status !== 'done').length,
    }),
    [worklistSnapshot],
  );
  const open = view !== null;

  const selectView = (next: SidebarView) => {
    setView((current) => (current === next ? null : next));
    if (next !== 'tools' && !requested.current.has(next)) {
      requested.current.add(next);
      requestWorklist?.(next);
    }
  };

  const openView = useCallback(
    (next: SidebarView) => {
      setView(next);
      if (next !== 'tools' && !requested.current.has(next)) {
        requested.current.add(next);
        requestWorklist?.(next);
      }
    },
    [requestWorklist],
  );

  useEffect(() => {
    return onOpenWorkspacePanel((view) => {
      openView(view);
    });
  }, [openView]);

  useEffect(() => {
    requested.current.clear();
  }, [worklistSnapshot.sessionId]);

  useEffect(() => {
    if (view !== 'flow') return;
    requestWorklist?.('flow');
    const interval = window.setInterval(() => requestWorklist?.('flow'), 15_000);
    return () => window.clearInterval(interval);
  }, [requestWorklist, view]);

  useEffect(() => {
    if (!open) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      // Participate in the topmost-panel convention: a handler that already
      // claimed this Escape (e.g. an inner panel) wins; otherwise claim it so
      // only ONE open surface closes per press. stopPropagation alone cannot
      // do that — it does not stop other listeners on the same node.
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setView(null);
      }
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [open]);

  const viewMeta = {
    tools: { label: 'TOOLS', icon: Wrench },
    flow: { label: 'FLOW', icon: Workflow },
    todos: { label: 'TODOS', icon: ListChecks },
    tasks: { label: 'TASKS', icon: ClipboardList },
    plan: { label: 'PLAN', icon: MapIcon },
  } satisfies Record<SidebarView, { label: string; icon: typeof Wrench }>;
  const ActiveIcon = view ? viewMeta[view].icon : Wrench;

  // Split calls: meta tools (compact) vs regular tools (expandable)
  const { metaCalls, regularCalls } = useMemo(
    () => ({
      metaCalls: calls.filter((c) => META_TOOLS.has(c.name) || c.status === 'running'),
      regularCalls: calls.filter((c) => !META_TOOLS.has(c.name) && c.status !== 'running'),
    }),
    [calls],
  );

  return (
    <>
      <nav className="tool-sidebar-launcher" aria-label="Workspace panels">
        {(
          [
            ['tools', 'TOOLS', PanelRight, calls.length],
            ['flow', 'FLOW', Workflow, worklistCounts.flow],
            ['todos', 'TODOS', ListChecks, worklistCounts.todos],
            ['tasks', 'TASKS', ClipboardList, worklistCounts.tasks],
            ['plan', 'PLAN', MapIcon, worklistCounts.plan],
          ] as const
        ).map(([itemView, label, Icon, count]) => (
          <button
            type="button"
            className={`tool-sidebar-trigger${view === itemView ? ' active' : ''}`}
            aria-expanded={view === itemView}
            aria-controls="tool-sidebar"
            onClick={() => selectView(itemView)}
            key={itemView}
          >
            <Icon size={14} aria-hidden="true" />
            <span>{label}</span>
            <b>{count}</b>
            {itemView === 'tools' && runningCount > 0 && (
              <i role="status" aria-label={`${runningCount} running tool calls`} />
            )}
          </button>
        ))}
      </nav>

      {/* Backdrop overlay — closes the panel when clicking outside */}
      {open && (
        <button
          type="button"
          className="sidebar-overlay"
          aria-label="Close sidebar panel"
          onClick={() => setView(null)}
        />
      )}

      {view && (
        <aside
          id="tool-sidebar"
          className="tool-sidebar"
          aria-label={view === 'tools' ? `${agentName} tool calls` : viewMeta[view].label}
          data-agent-id={agentId}
          data-view={view}
        >
          <header className="tool-sidebar-header">
            <div>
              <ActiveIcon size={14} aria-hidden="true" />
              <span>{viewMeta[view].label}</span>
              <b>{view === 'tools' ? agentName : 'SESSION WORK'}</b>
            </div>
            <button
              type="button"
              aria-label={`Close ${viewMeta[view].label.toLowerCase()}`}
              onClick={() => setView(null)}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </header>
          <div className="tool-sidebar-list">
            {view === 'tools' ? (
              calls.length === 0 ? (
                <div className="tool-sidebar-empty">No tool calls yet.</div>
              ) : (
                <>
                  {/* Running & meta tools — compact status line */}
                  {metaCalls.map((call) => (
                    <div className={`tool-sidebar-meta ${call.status}`} key={call.id}>
                      <span className="tool-sidebar-meta-name">{call.name}</span>
                      {call.status === 'running' ? (
                        <LoaderCircle size={11} className="spin" aria-label="Running" />
                      ) : call.status === 'done' ? (
                        <Check size={11} className="tool-sidebar-ok" aria-label="Done" />
                      ) : (
                        <X size={11} className="tool-sidebar-error" aria-label="Error" />
                      )}
                      <span className="tool-sidebar-meta-status">
                        {call.status === 'running'
                          ? 'running'
                          : call.status === 'done'
                            ? 'done'
                            : 'error'}
                      </span>
                    </div>
                  ))}

                  {/* Regular tools — expandable detail */}
                  {regularCalls.map((call) => {
                    const isExpanded = expanded.includes(call.id);
                    return (
                      <article className={`tool-sidebar-call ${call.status}`} key={call.id}>
                        <button
                          type="button"
                          className="tool-sidebar-call-trigger"
                          aria-expanded={isExpanded}
                          onClick={() =>
                            setExpanded((current) =>
                              current.includes(call.id)
                                ? current.filter((id) => id !== call.id)
                                : [...current, call.id],
                            )
                          }
                        >
                          {isExpanded ? (
                            <ChevronDown size={12} aria-hidden="true" />
                          ) : (
                            <ChevronRight size={12} aria-hidden="true" />
                          )}
                          <code>{call.name}</code>
                          {call.status === 'running' ? (
                            <LoaderCircle size={12} className="spin" aria-label="Running" />
                          ) : call.status === 'done' ? (
                            <Check size={12} className="tool-sidebar-ok" aria-label="Done" />
                          ) : (
                            <X size={12} className="tool-sidebar-error" aria-label="Error" />
                          )}
                          <span>
                            {call.status === 'running'
                              ? 'Running'
                              : call.status === 'done'
                                ? `Done${call.durationMs != null ? ` · ${call.durationMs}ms` : ''}`
                                : 'Error'}
                          </span>
                        </button>
                        {isExpanded && (
                          <div className="tool-sidebar-call-detail">
                            {call.input !== undefined && (
                              <section>
                                <span>INPUT</span>
                                <pre>{displayValue(call.input)}</pre>
                              </section>
                            )}
                            {call.output !== undefined && (
                              <section>
                                <span>OUTPUT</span>
                                <pre>{displayValue(call.output)}</pre>
                              </section>
                            )}
                          </div>
                        )}
                      </article>
                    );
                  })}
                </>
              )
            ) : (
              <Suspense fallback={<div className="tool-sidebar-empty">Loading {view}…</div>}>
                <LazyWorklistSidebar
                  view={view}
                  snapshot={worklistSnapshot}
                  onTodoStatusChange={onTodoStatusChange}
                  onTaskStatusChange={onTaskStatusChange}
                  onPlanStatusChange={onPlanStatusChange}
                />
              </Suspense>
            )}
          </div>
        </aside>
      )}
    </>
  );
}
