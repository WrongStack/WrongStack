/**
 * `/kanban` — Open the project kanban panel and perform common board/task
 * operations from the TUI composer.
 *
 * Subcommands (no subcommand → opens the kanban panel):
 *
 *   /kanban                          — open the project kanban panel
 *   /kanban create <title>               — create a new board, then open the panel
 *   /kanban add <title> [--column X] [--desc <text>] — add a task to the active board (managed boards require --desc)
 *   /kanban use <boardId|title|tag>      — open the kanban panel on a specific board
 *   /kanban boards                       — list every board in the project
 *   /kanban health                       — show kanban queue health summary
 *   /kanban audit [boardId|all]          — show kanban cleaner audit (KanbanAuditSummary)
 *   /kanban help                         — show usage
 *
 * The slash command intentionally mirrors the WebUI `kanban` surface so
 * users can perform the same operations in either surface. The TUI panel
 * remains the rich interactive view (navigate, move, assign); this command
 * is the text-first equivalent for when the panel is closed.
 */
import type { SlashCommand } from '@wrongstack/contracts/types';
import type {
  CreateKanbanTaskInput,
  KanbanBoardSummary,
  KanbanBoundaryPolicy,
  KanbanColumn,
  KanbanEventContext,
} from '@wrongstack/kanban';
import {
  addTask,
  createBoard,
  getBoard,
  getKanbanQueueHealth,
  listBoards,
  updateBoard,
  updateTask,
} from '@wrongstack/kanban';
import type { ParsedKanbanArgs } from './kanban-arguments.js';
import { parseKanbanArgs } from './kanban-arguments.js';
import type { KanbanAddTarget, KanbanSlashDeps } from './kanban-command-types.js';
import { renderBoardsList, renderHealthReport, renderProjectAudit } from './kanban-reports.js';

// ── Slash command factory ───────────────────────────────────────────────────

const USAGE =
  'Usage:\n' +
  '  /kanban                              — open the project kanban panel\n' +
  '  /kanban create <title>               — create a board, then open the panel\n' +
  '  /kanban add <title> [--column X] [--desc <text>] — add a task to the active board (managed boards require --desc)\n' +
  '  /kanban use <boardId|title|tag>      — open the panel on a specific board\n' +
  '  /kanban boards                       — list every board in the project\n' +
  '  /kanban health                       — show kanban queue health summary\n' +
  '  /kanban audit [boardId|all]          — show kanban cleaner audit (all boards if omitted)\n' +
  '  /kanban boundary <board> show [--task ID]\n' +
  '  /kanban boundary <board> allow|deny <kind> <access> <path> [--task ID] [--enforcement confirm|block] [--shell allow|confirm|block]\n' +
  '  /kanban boundary <board> clear [--task ID]\n' +
  '  /kanban help                         — show this help';

const KANBAN_PANEL_ACTION = 'toggleKanbanPanel';

export function createKanbanSlashCommand(deps: KanbanSlashDeps): SlashCommand {
  return {
    name: 'kanban',
    description: 'Open the kanban panel, create a board, add a task, or list boards.',
    argsHint: '[create <title> | add <title> | boards | help]',
    category: 'App',
    help: USAGE,
    async run(args) {
      try {
        const parsed = parseKanbanArgs(args);
        if (parsed.kind === 'help') {
          return { message: USAGE };
        }
        if (parsed.kind === 'open') {
          const opened = deps.onPanelOpen?.current?.(KANBAN_PANEL_ACTION) ?? false;
          if (!opened) {
            return {
              message: 'Kanban panel bridge not available — run /help kanban for text commands.',
            };
          }
          return { message: '' };
        }
        if (parsed.kind === 'create') {
          const tags = deps.sessionId ? [`session:${deps.sessionId}`] : undefined;
          const created = await createBoard(deps.projectRoot, {
            title: parsed.title,
            ...(tags ? { tags } : {}),
          });
          deps.onPanelOpen?.current?.(KANBAN_PANEL_ACTION);
          return {
            message: `Created board "${created.title}" (${created.id.slice(0, 8)}…). Opening panel…`,
          };
        }
        if (parsed.kind === 'boards') {
          const boards = await listBoards(deps.projectRoot);
          return {
            message: renderBoardsList(boards, deps.terminalWidth ?? 80),
          };
        }
        if (parsed.kind === 'add') {
          const target = await resolveAddTarget(deps, parsed.column);
          if (!target) {
            return {
              message: 'No kanban board found. Use `/kanban create <title>` to make one first.',
            };
          }
          // Managed boards require a description on every card (see
          // `initializeAndValidateManagedTask` in `@wrongstack/kanban`).
          // Instead of letting the create call fail with a cryptic validation
          // error, point the user at the `--desc` flag.
          if (target.managed && !parsed.description) {
            return {
              message:
                `"${target.boardTitle}" is a managed board — every card needs a description. ` +
                `Try: /kanban add "${parsed.title}" --desc "<what the task is>"`,
            };
          }
          const created = await addTaskToBoard(
            deps.projectRoot,
            target,
            parsed.title,
            parsed.description,
            slashEventContext(deps),
          );
          if (!created) {
            return {
              message: `Failed to add task to "${target.boardTitle}" — no writable column found.`,
            };
          }
          deps.onPanelOpen?.current?.(KANBAN_PANEL_ACTION);
          const columnHint = target.managed ? ' (backlog)' : '';
          return {
            message: `Added task "${created.title}" to "${target.boardTitle}" → ${created.columnId}${columnHint}. Opening panel…`,
          };
        }
        if (parsed.kind === 'use') {
          const resolved = await resolveBoardByQuery(deps, parsed.query);
          if (!resolved) {
            return {
              message: `No kanban board matches "${parsed.query}". Run \`/kanban boards\` to see available boards.`,
            };
          }
          // Both bridges must succeed before we report navigation. Either
          // missing is a soft-no-op (slash command remains text-only), so
          // we degrade gracefully instead of misleading the user.
          const panelOpened = deps.onPanelOpen?.current?.(KANBAN_PANEL_ACTION) ?? false;
          const boardFocused = deps.onBoardFocus?.current?.(resolved.id) ?? false;
          if (!panelOpened && !boardFocused) {
            return {
              message: `Found "${resolved.title}" but the kanban panel bridge is not available in this host.`,
            };
          }
          if (!panelOpened) {
            return {
              message: `Found "${resolved.title}" but the kanban panel did not open (host may be headless).`,
            };
          }
          if (!boardFocused) {
            // Panel opened but we couldn't focus a specific board — degrade
            // to a plain open; the panel's session-tag fallback will pick
            // a board.
            return {
              message: `Opening kanban panel; could not focus "${resolved.title}" specifically (no focus bridge).`,
            };
          }
          return {
            message: `Opening "${resolved.title}" (${resolved.id.slice(0, 8)}…) in the kanban panel…`,
          };
        }
        if (parsed.kind === 'health') {
          const health = await getKanbanQueueHealth(deps.projectRoot);
          return { message: renderHealthReport(health) };
        }
        if (parsed.kind === 'audit') {
          const report = await renderProjectAudit(deps, parsed.boardQuery);
          return { message: report };
        }
        if (parsed.kind === 'boundary') {
          return { message: await applyBoundaryCommand(deps, parsed) };
        }
        // Exhaustiveness — TypeScript narrows `parsed` to never here.
        return { message: USAGE };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { message: `Kanban command failed: ${msg}` };
      }
    },
  };
}

type ParsedBoundaryCommand = Extract<ParsedKanbanArgs, { kind: 'boundary' }>;

async function applyBoundaryCommand(
  deps: KanbanSlashDeps,
  command: ParsedBoundaryCommand,
): Promise<string> {
  const summary = await resolveBoardByQuery(deps, command.boardQuery);
  if (!summary) return `No kanban board matches "${command.boardQuery}".`;
  const board = await getBoard(deps.projectRoot, summary.id);
  if (!board) return `Board not found: ${summary.id}`;
  const task = command.taskQuery
    ? board.tasks.find(
        (candidate) =>
          candidate.id === command.taskQuery ||
          candidate.id.startsWith(command.taskQuery!) ||
          candidate.title.toLowerCase() === command.taskQuery!.toLowerCase(),
      )
    : undefined;
  if (command.taskQuery && !task) return `Task not found: ${command.taskQuery}`;
  const current = task ? task.boundary : board.boundary;

  if (command.action === 'show') {
    const inherited = task && board.boundary?.enabled ? renderBoundaryPolicy(board.boundary) : '';
    return [
      `🛡️ **${task ? `Task: ${task.title}` : `Board: ${board.title}`} boundary**`,
      renderBoundaryPolicy(current),
      inherited ? `\nBoard ceiling:\n${inherited}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  if (command.action === 'clear') {
    if (task) {
      await updateTask(
        deps.projectRoot,
        board.id,
        task.id,
        { boundary: null },
        slashEventContext(deps),
      );
    } else await updateBoard(deps.projectRoot, board.id, { boundary: null });
    return `Removed ${task ? 'task' : 'board'} boundary layer.`;
  }

  const base: KanbanBoundaryPolicy = current ?? {
    enabled: true,
    enforcement: 'confirm',
    shellAccess: 'confirm',
    allow: [],
  };
  const selector = {
    kind: command.selectorKind!,
    access: command.access!,
    path: command.path!,
  };
  const policy: KanbanBoundaryPolicy = {
    ...base,
    enabled: true,
    enforcement: command.enforcement ?? base.enforcement,
    shellAccess: command.shellAccess ?? base.shellAccess,
    allow:
      command.action === 'allow' ? uniqueBoundarySelectors([...base.allow, selector]) : base.allow,
    ...(command.action === 'deny'
      ? { deny: uniqueBoundarySelectors([...(base.deny ?? []), selector]) }
      : base.deny
        ? { deny: base.deny }
        : {}),
  };
  if (task) {
    await updateTask(
      deps.projectRoot,
      board.id,
      task.id,
      { boundary: policy },
      slashEventContext(deps),
    );
  } else await updateBoard(deps.projectRoot, board.id, { boundary: policy });
  return `Saved ${task ? 'task' : 'board'} boundary: ${command.action} ${selector.access} ${selector.kind}:${selector.path}.`;
}

function renderBoundaryPolicy(policy: KanbanBoundaryPolicy | undefined): string {
  if (!policy?.enabled) return 'unrestricted';
  const lines = [
    `mode ${policy.enforcement} · shell ${policy.shellAccess}`,
    ...policy.allow.map((selector) => `ALLOW ${selector.access} ${selector.kind}:${selector.path}`),
    ...(policy.deny ?? []).map(
      (selector) => `DENY  ${selector.access} ${selector.kind}:${selector.path}`,
    ),
  ];
  return lines.join('\n');
}

function uniqueBoundarySelectors(
  selectors: KanbanBoundaryPolicy['allow'],
): KanbanBoundaryPolicy['allow'] {
  const seen = new Set<string>();
  return selectors.filter((selector) => {
    const key = `${selector.kind}:${selector.access}:${selector.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Board resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the board that an `/kanban add` should target, matching the
 * precedence used by `KanbanPanel`:
 *
 *   1. The board tagged with `session:<sessionId>` (when a session id is known).
 *   2. The most-recently-updated board (sort by `updatedAt` desc).
 *
 * If `column` is given, prefer a column whose id or title matches. The match is
 * case-insensitive and falls back to the first column when nothing matches.
 *
 * Exported so tests can validate the precedence rules against fixture boards.
 */
export async function resolveAddTarget(
  deps: Pick<KanbanSlashDeps, 'projectRoot' | 'sessionId'>,
  column: string | null,
): Promise<KanbanAddTarget | null> {
  const summaries = await listBoards(deps.projectRoot);
  if (summaries.length === 0) return null;

  const sessionTag = deps.sessionId ? `session:${deps.sessionId}` : null;
  const preferred =
    (sessionTag ? summaries.find((b) => b.tags?.includes(sessionTag)) : undefined) ??
    [...summaries].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

  if (!preferred) return null;

  const board = await getBoard(deps.projectRoot, preferred.id);
  if (!board) return null;

  const managed = board.lifecycle?.mode === 'managed';
  const firstColumn = board.columns[0];
  // Managed boards must create cards in the Backlog column (see
  // `initializeManagedTaskLifecycle` in `@wrongstack/kanban`); ignore any
  // caller-supplied column hint so the task lands where the lifecycle allows.
  const backlogColumnId = managed ? board.lifecycle?.columns?.backlog : undefined;
  const backlogColumn = backlogColumnId
    ? board.columns.find((c) => c.id === backlogColumnId)
    : undefined;
  const targetColumn = managed
    ? (backlogColumn ?? firstColumn)
    : (resolveColumn(board.columns, column) ?? firstColumn);
  if (!targetColumn) return null;

  return {
    boardId: board.id,
    boardTitle: board.title,
    columnId: targetColumn.id,
    managed,
  };
}

function resolveColumn(
  columns: readonly KanbanColumn[],
  hint: string | null,
): KanbanColumn | undefined {
  if (!hint) return undefined;
  const needle = hint.trim().toLowerCase();
  if (!needle) return undefined;
  const byId = columns.find((c) => c.id.toLowerCase() === needle);
  if (byId) return byId;
  return columns.find((c) => c.title.toLowerCase() === needle);
}

/**
 * Resolve a user-supplied board query to a specific board. Three match
 * strategies are tried in order:
 *
 *   1. **Exact id match** — fastest, never ambiguous.
 *   2. **Exact title match** (case-insensitive) — what `/kanban use Sprint 2`
 *      should hit when the user types the title verbatim.
 *   3. **Tag match** — for `goal:<text>` or `session:<id>` tags so the
 *      Goal → Kanban bridge can navigate by tag without knowing the id.
 *
 * Returns null when no summary matches. The caller can then surface a
 * helpful error pointing at `/kanban boards`.
 */
async function resolveBoardByQuery(
  deps: Pick<KanbanSlashDeps, 'projectRoot'>,
  query: string,
): Promise<KanbanBoardSummary | null> {
  const needle = query.trim();
  if (!needle) return null;
  const summaries = await listBoards(deps.projectRoot);
  if (summaries.length === 0) return null;

  const lower = needle.toLowerCase();
  // 1. Exact id match — accepts full or 8-char-prefix matches so users
  //    can copy-paste from the panel footer.
  const byId =
    summaries.find((b) => b.id === needle) ??
    summaries.find((b) => b.id.slice(0, 8).toLowerCase() === lower.slice(0, 8));
  if (byId) return byId;

  // 2. Exact title match (case-insensitive).
  const byTitle = summaries.find((b) => b.title.toLowerCase() === lower);
  if (byTitle) return byTitle;

  // 3. Tag match — covers `goal:<text>` and `session:<id>` so the
  //    bridge can call `/kanban use goal:auth` to land on a goal board.
  const byTag = summaries.find((b) => b.tags?.some((t) => t.toLowerCase() === lower));
  if (byTag) return byTag;

  return null;
}

// ── Task creation wrapper ───────────────────────────────────────────────────

/**
 * Add a task to the resolved board/column. Returns the created task so the
 * command can echo its id and column placement.
 */
/** Attribution for every board write `/kanban` makes on the user's behalf. */
function slashEventContext(deps: Pick<KanbanSlashDeps, 'sessionId'>): KanbanEventContext {
  return { sessionId: deps.sessionId, actor: 'tui-operator' };
}

async function addTaskToBoard(
  cwd: string,
  target: KanbanAddTarget,
  title: string,
  description: string | undefined,
  eventContext: KanbanEventContext,
): Promise<{ title: string; columnId: string; id: string } | null> {
  const input: CreateKanbanTaskInput = {
    title,
    columnId: target.columnId,
    ...(description ? { description } : {}),
  };
  const result = await addTask(cwd, target.boardId, input, eventContext);
  if (!result) return null;
  return { title: result.task.title, columnId: result.task.columnId, id: result.task.id };
}

export { parseKanbanArgs } from './kanban-arguments.js';
export type { KanbanSlashDeps } from './kanban-command-types.js';
export { renderAuditReport, renderBoardsList, renderHealthReport } from './kanban-reports.js';
