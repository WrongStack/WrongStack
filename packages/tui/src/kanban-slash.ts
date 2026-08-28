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
import type { SlashCommand } from '@wrongstack/core/types';
import type {
  CreateKanbanTaskInput,
  KanbanBoardSummary,
  KanbanBoundaryAccess,
  KanbanBoundaryPolicy,
  KanbanBoundarySelectorKind,
  KanbanColumn,
  KanbanEventContext,
  KanbanQueueHealth,
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
import { auditKanbanBoard, type KanbanAuditSummary } from './kanban-audit.js';

// ── Public types ────────────────────────────────────────────────────────────

/**
 * Result of resolving the board that an `add` operation should target.
 *
 * `KanbanPanel` resolves the active board from the session tag
 * (`session:<sessionId>`) and falls back to the most-recently-updated board.
 * We mirror that exact precedence so a `/kanban add` issued while the panel
 * is open lands on the same board the user is looking at.
 */
interface KanbanAddTarget {
  boardId: string;
  boardTitle: string;
  /** Column that the task will be placed in. Defaults to the first column. */
  columnId: string;
  /**
   * Whether the board enforces the managed Kanban Agent lifecycle. Managed
   * boards require new cards to be created in the Backlog column and with a
   * description, so callers route the user accordingly.
   */
  managed: boolean;
}

export interface KanbanSlashDeps {
  /**
   * Absolute project root used by the kanban file store. Must match the
   * value `KanbanPanel` reads from `agent.ctx.projectRoot` — using
   * `agent.ctx.cwd` would diverge when the user launches the TUI from a
   * subdirectory of the project.
   */
  projectRoot: string;
  /**
   * Session running the TUI. Used to prefer a `session:<id>`-tagged board, and
   * to attribute every board event `/kanban` writes.
   */
  sessionId: string;
  /**
   * Panel-open bridge installed by `App`. Calling `onPanelOpen.current(...)`
   * with `'toggleKanbanPanel'` opens the kanban panel — same mechanism the
   * other slash commands use. When absent, slash command returns text-only.
   */
  onPanelOpen?: { current: ((action: string) => boolean) | null } | undefined;
  /**
   * Optional hook that selects a specific board in the kanban panel. Used
   * by `/kanban use <boardId|title|tag>` and the Goal → Kanban bridge.
   * The callback receives a board id and returns true on success.
   */
  onBoardFocus?: { current: ((boardId: string) => boolean) | null } | undefined;
  /** Terminal width (cols) for help / boards table rendering. */
  terminalWidth?: number | undefined;
}

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

// ── Argument parser ─────────────────────────────────────────────────────────

type ParsedKanbanArgs =
  | { kind: 'open' }
  | { kind: 'help' }
  | { kind: 'boards' }
  | { kind: 'create'; title: string }
  | { kind: 'add'; title: string; column: string | null; description?: string | undefined }
  | { kind: 'use'; query: string }
  | { kind: 'health' }
  | { kind: 'audit'; boardQuery: string }
  | {
      kind: 'boundary';
      boardQuery: string;
      action: 'show' | 'allow' | 'deny' | 'clear';
      taskQuery?: string | undefined;
      selectorKind?: KanbanBoundarySelectorKind | undefined;
      access?: KanbanBoundaryAccess | undefined;
      path?: string | undefined;
      enforcement?: KanbanBoundaryPolicy['enforcement'] | undefined;
      shellAccess?: KanbanBoundaryPolicy['shellAccess'] | undefined;
    };

/**
 * Parse the raw `args` string (everything after `/kanban`) into a tagged
 * union. Exported so tests can exercise the grammar in isolation.
 *
 * Grammar (whitespace-separated; quoted titles supported for the `create`
 * subcommand):
 *
 *   args       ::= ε | "help" | "boards" | "create" title
 *                |  "add" title ("--" "column" columnId)?
 *   title      ::= token+
 *   columnId   ::= token
 */
export function parseKanbanArgs(raw: string): ParsedKanbanArgs {
  const tokens = tokenize(raw.trim());
  if (tokens.length === 0) return { kind: 'open' };
  const head = tokens[0]?.toLowerCase() ?? '';
  if (head === 'help' || head === '--help' || head === '-h') return { kind: 'help' };
  if (head === 'boards' || head === 'list' || head === 'ls') {
    return { kind: 'boards' };
  }
  if (head === 'create' || head === 'new' || head === 'add-board') {
    const title = tokens.slice(1).join(' ').trim();
    if (!title) return { kind: 'help' };
    return { kind: 'create', title };
  }
  if (head === 'add' || head === 'add-task' || head === 'task') {
    let title = '';
    let column: string | null = null;
    let description: string | null = null;
    for (let i = 1; i < tokens.length; i++) {
      const tok = tokens[i] ?? '';
      if (tok === '--column' || tok === '-c') {
        const next = tokens[i + 1];
        if (next) {
          column = next;
          i++;
        }
        continue;
      }
      if (tok.startsWith('--column=')) {
        column = tok.slice('--column='.length);
        continue;
      }
      if (tok === '--desc' || tok === '-d') {
        const next = tokens[i + 1];
        if (next) {
          description = next;
          i++;
        }
        continue;
      }
      if (tok.startsWith('--desc=')) {
        description = tok.slice('--desc='.length);
        continue;
      }
      title = title ? `${title} ${tok}` : tok;
    }
    title = title.trim();
    if (!title) return { kind: 'help' };
    return {
      kind: 'add',
      title,
      column,
      ...(description ? { description } : {}),
    };
  }
  if (head === 'use' || head === 'open-board' || head === 'focus') {
    const query = tokens.slice(1).join(' ').trim();
    if (!query) return { kind: 'help' };
    return { kind: 'use', query };
  }
  if (head === 'health' || head === 'queue' || head === 'status') {
    return { kind: 'health' };
  }
  if (head === 'boundary' || head === 'scope' || head === 'bounds') {
    const boardQuery = tokens[1] ?? '';
    const action = (tokens[2]?.toLowerCase() ?? 'show') as 'show' | 'allow' | 'deny' | 'clear';
    if (!boardQuery || !['show', 'allow', 'deny', 'clear'].includes(action)) {
      return { kind: 'help' };
    }
    const readFlag = (name: string): string | undefined => {
      const index = tokens.indexOf(name);
      return index >= 0 ? tokens[index + 1] : undefined;
    };
    const taskQuery = readFlag('--task');
    const enforcement = readFlag('--enforcement');
    const shellAccess = readFlag('--shell');
    if (enforcement && enforcement !== 'confirm' && enforcement !== 'block') {
      return { kind: 'help' };
    }
    if (shellAccess && !['allow', 'confirm', 'block'].includes(shellAccess)) {
      return { kind: 'help' };
    }
    if (action === 'show' || action === 'clear') {
      return {
        kind: 'boundary',
        boardQuery,
        action,
        ...(taskQuery ? { taskQuery } : {}),
      };
    }
    const selectorKind = tokens[3] as KanbanBoundarySelectorKind | undefined;
    const access = tokens[4] as KanbanBoundaryAccess | undefined;
    const selectorPath = tokens[5];
    if (
      !selectorKind ||
      !['file', 'directory', 'package', 'glob'].includes(selectorKind) ||
      !access ||
      !['read', 'write', 'read_write'].includes(access) ||
      !selectorPath
    ) {
      return { kind: 'help' };
    }
    return {
      kind: 'boundary',
      boardQuery,
      action,
      selectorKind,
      access,
      path: selectorPath,
      ...(taskQuery ? { taskQuery } : {}),
      ...(enforcement ? { enforcement: enforcement as KanbanBoundaryPolicy['enforcement'] } : {}),
      ...(shellAccess ? { shellAccess: shellAccess as KanbanBoundaryPolicy['shellAccess'] } : {}),
    };
  }
  if (head === 'audit' || head === 'clean' || head === 'cleaner') {
    // `audit` runs against every board when no argument is supplied;
    // `audit <query>` runs against one board (id / title / tag).
    const boardQuery = tokens.slice(1).join(' ').trim();
    return { kind: 'audit', boardQuery };
  }
  // Unknown subcommand — show the usage text so users discover the right
  // command shape instead of getting a silent "command not found".
  return { kind: 'help' };
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

/**
 * Tokenize the raw `args` string honoring simple shell-style quoting so a
 * title like `Sprint 2 — "Done" state` survives intact.
 *
 * Rules:
 *   - Whitespace separates tokens (spaces and tabs).
 *   - Double-quoted spans preserve spaces; `\\` and `\"` are unescaped.
 *   - Single quotes are literal — no escapes inside.
 *   - A trailing unclosed quote is treated literally (we never throw).
 */
function tokenize(raw: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inSingle) {
      if (ch === "'") {
        inSingle = false;
        continue;
      }
      current += ch;
      continue;
    }
    if (inDouble) {
      if (ch === '\\' && raw[i + 1] === '"') {
        current += '"';
        i++;
        continue;
      }
      if (ch === '\\' && raw[i + 1] === '\\') {
        current += '\\';
        i++;
        continue;
      }
      if (ch === '"') {
        inDouble = false;
        continue;
      }
      current += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
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

// ── Health report ────────────────────────────────────────────────────────────

/**
 * Render the kanban queue health report as a compact markdown block.
 * Surfaces the same Sprint-2 fields the WebUI's `KanbanView` shows
 * (dependencyBlocked, staleAssignments, failedRetryable, heartbeatDue)
 * plus per-status counts and the last dispatch / last recovery stamps.
 */
export function renderHealthReport(health: KanbanQueueHealth): string {
  const c = health.counts;
  // The KanbanQueueHealth buckets overlap: `queued` is an assignment overlay
  // that can coexist with `pending` or `ready`, and `blocked` is a status
  // distinct from the lifecycle buckets. Summing them inflates the total.
  // Use a clear partitioning: pending + ready + running + review + failed +
  // completed + archived + blocked are mutually-exclusive lifecycle/status
  // buckets; `queued` is reported separately as an assignment count.
  const lifecycleTotal =
    c.pending + c.ready + c.running + c.review + c.failed + c.completed + c.archived + c.blocked;
  const header = [
    '🩺 **Kanban queue health**',
    '',
    `  ${lifecycleTotal} task${lifecycleTotal === 1 ? '' : 's'} across ${
      health.boardIds.length
    } board${health.boardIds.length === 1 ? '' : 's'} (generated ${health.generatedAt})`,
    c.queued > 0 ? `  + ${c.queued} currently queued for assignment (subset)` : '',
    '',
    '  **Per-status counts**',
    // `startable`, not `ready`. `counts.ready` tallies the stored status field,
    // which no dispatcher writes, so it printed a permanent 0 while
    // `ready_tasks` on the same board returned work. `counts.startable` is the
    // derived answer and agrees with `listReadyTasks`.
    //
    // `lifecycleTotal` above still sums `c.ready` on purpose: that is the
    // single-count partition, and `startable` overlaps `pending`/`ready`, so
    // swapping it there would double-count. These two lines are meant to differ.
    `    startable ${c.startable} · running ${c.running} · review ${c.review}` +
      ` · failed ${c.failed} · completed ${c.completed}`,
    `    pending ${c.pending} · archived ${c.archived} · blocked ${c.blocked}` +
      (c.queued > 0 ? ` · queued ${c.queued}` : ''),
    '',
  ].filter((line) => line !== '');

  const attention: string[] = ['  **Attention signals**'];
  attention.push(
    `    dependency-blocked  ${health.dependencyBlocked.count}` +
      (health.dependencyBlocked.count > 0
        ? `  (first: ${summarizeSearchResult(health.dependencyBlocked.tasks[0])})`
        : ''),
  );
  attention.push(
    `    stale-assignments   ${health.staleAssignments.count}` +
      (health.staleAssignments.count > 0
        ? `  (first: ${summarizeSearchResult(health.staleAssignments.tasks[0])})`
        : ''),
  );
  attention.push(
    `    failed-retryable    ${health.failedRetryable.count}` +
      (health.failedRetryable.count > 0
        ? `  (first: ${summarizeSearchResult(health.failedRetryable.tasks[0])})`
        : ''),
  );
  attention.push(
    `    heartbeat-due       ${health.heartbeatDue.count}` +
      (health.heartbeatDue.count > 0
        ? `  (first: ${summarizeSearchResult(health.heartbeatDue.tasks[0])})`
        : ''),
  );
  attention.push('');

  const stamps: string[] = ['  **Activity**'];
  stamps.push(`    last dispatch    ${health.lastDispatchedAt ?? 'never'}`);
  stamps.push(`    last recovery    ${health.lastStaleRecoveredAt ?? 'never'}`);
  stamps.push('', '  Use `/kanban` to inspect any board visually.');

  return [...header, ...attention, ...stamps].join('\n');
}

function summarizeSearchResult(
  result: { board: { title: string }; task: { title: string } } | undefined,
): string {
  if (!result) return '';
  return `"${result.task.title}" on ${result.board.title}`;
}

// ── Audit report ────────────────────────────────────────────────────────────

/**
 * Render the Kanban Cleaner audit across the project. Mirrors the WebUI
 * `KanbanCleanerAlert` vocabulary so a user running either surface gets
 * the same findings.
 *
 * Two modes:
 *   - `boardQuery` empty   → audit every board (per-board table).
 *   - `boardQuery` present → audit the single matching board, or report
 *     a clear "not found" error.
 *
 * Each board's row shows the issue counts (error · warning) and the
 * top-3 issues, biasing toward error severity first.
 */
async function renderProjectAudit(
  deps: Pick<KanbanSlashDeps, 'projectRoot'>,
  boardQuery: string,
): Promise<string> {
  const summaries = await listBoards(deps.projectRoot);
  if (summaries.length === 0) {
    return [
      '🧹 **Kanban Cleaner audit**',
      '',
      '  No boards exist yet — run `/kanban create <title>` first.',
    ].join('\n');
  }

  let targets = summaries;
  if (boardQuery.length > 0) {
    const needle = boardQuery.toLowerCase();
    const matched = summaries.find(
      (b) =>
        b.id === boardQuery ||
        b.id.slice(0, 8).toLowerCase() === needle.slice(0, 8) ||
        b.title.toLowerCase() === needle ||
        b.tags?.some((t) => t.toLowerCase() === needle),
    );
    if (!matched) {
      return [
        '🧹 **Kanban Cleaner audit**',
        '',
        `  No kanban board matches "${boardQuery}". Run \`/kanban boards\` to see available boards.`,
      ].join('\n');
    }
    targets = [matched];
  }

  // Iterate sequentially; each board is small enough that a single
  // for-loop is cheaper than parallel reads (the kanban store is
  // process-local). Errors per-board degrade gracefully — the rest
  // of the report still renders.
  const rows: Array<{
    title: string;
    summary: KanbanAuditSummary;
    error?: string;
  }> = [];
  for (const target of targets) {
    try {
      const board = await getBoard(deps.projectRoot, target.id);
      if (!board) {
        rows.push({ title: target.title, summary: emptyAuditSummary(), error: 'Board not found' });
        continue;
      }
      const summary = auditKanbanBoard(board, { now: new Date() });
      rows.push({ title: target.title, summary });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      rows.push({ title: target.title, summary: emptyAuditSummary(), error: message });
    }
  }

  return renderAuditReport(rows, boardQuery.length === 0);
}

/** Empty `KanbanAuditSummary` placeholder used when a board can't be loaded. */
function emptyAuditSummary(): KanbanAuditSummary {
  return {
    generatedAt: new Date().toISOString(),
    boardIds: [],
    counts: { error: 0, warning: 0 },
    dependencyBlocked: { count: 0, tasks: [] },
    staleAssignments: { count: 0, tasks: [] },
    failedRetryable: { count: 0, tasks: [] },
    heartbeatDue: { count: 0, tasks: [] },
    lastDispatchedAt: undefined,
    lastStaleRecoveredAt: undefined,
    issues: [],
    affectedTaskCount: 0,
  };
}

/**
 * Render a board-row table from a list of audited boards. The output
 * is a compact markdown block suitable for the slash composer.
 *
 * When `multi` is true (audit-all mode) each row is prefixed with the
 * board title; in single-board mode the title appears once as a header.
 */
export function renderAuditReport(
  rows: ReadonlyArray<{ title: string; summary: KanbanAuditSummary; error?: string }>,
  multi: boolean,
): string {
  const headline = [
    '🧹 **Kanban Cleaner audit**',
    '',
    multi ? `  ${rows.length} board${rows.length === 1 ? '' : 's'} scanned` : `  Single-board scan`,
    '',
  ];

  const body: string[] = [];
  for (const row of rows) {
    if (multi) body.push(`**${row.title}**`);
    if (row.error) {
      body.push(`  ⚠ Could not audit: ${row.error}`);
      if (multi) body.push('');
      continue;
    }
    const s = row.summary;
    const total = s.counts.error + s.counts.warning;
    const headline2 =
      total === 0
        ? '  ✓ Clean (no cleaner findings)'
        : `  ${total} cleaner issue${total === 1 ? '' : 's'} (${s.counts.error} error · ${s.counts.warning} warning)`;
    body.push(headline2);
    if (total === 0) {
      if (multi) body.push('');
      continue;
    }
    // Top-3 issues, error-first — re-sort defensively so callers that
    // pass a manually-built summary still get the right ordering.
    const top = [...s.issues]
      .sort((a, b) => {
        const sev = severityRank(a.severity) - severityRank(b.severity);
        return sev !== 0 ? sev : a.taskTitle.localeCompare(b.taskTitle);
      })
      .slice(0, 3);
    for (const issue of top) {
      body.push(
        `    ${issue.severity === 'error' ? '⨯' : '!'} ${issue.code} — ${issue.taskTitle}: ${issue.message}`,
      );
    }
    if (s.issues.length > top.length) {
      body.push(`    … and ${s.issues.length - top.length} more`);
    }
    if (multi) body.push('');
  }
  return [...headline, ...body].join('\n');
}

function severityRank(severity: 'error' | 'warning'): number {
  return severity === 'error' ? 0 : 1;
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

// ── Renderers (exported for testing) ─────────────────────────────────────────

/**
 * Render a compact boards table. Width-aware so a 60-col terminal still gets
 * useful output (column titles truncated, counts abbreviated).
 */
export function renderBoardsList(boards: readonly KanbanBoardSummary[], width = 80): string {
  if (boards.length === 0) {
    return [
      '📋 **Kanban boards** — none yet',
      '',
      '  Create one with `/kanban create <title>`.',
    ].join('\n');
  }

  const sorted = [...boards].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const titleWidth = Math.max(12, Math.min(40, Math.floor(width / 2) - 4));
  const idWidth = 8;
  const tagMarker = sorted.some((b) => b.tags && b.tags.length > 0);

  const header = [
    '📋 **Kanban boards**',
    '',
    `  ${sorted.length} board${sorted.length === 1 ? '' : 's'}` +
      (sorted.some((b) => b.taskCount > 0)
        ? ` · ${sorted.reduce((s, b) => s + b.taskCount, 0)} tasks` +
          ` · ${sorted.reduce((s, b) => s + b.completedTaskCount, 0)} done`
        : ''),
    '',
  ];

  const rows: string[] = [];
  for (const board of sorted) {
    const title = truncate(board.title, titleWidth);
    const id = board.id.slice(0, idWidth);
    const taskInfo =
      `${board.taskCount} task${board.taskCount === 1 ? '' : 's'}` +
      (board.completedTaskCount > 0 ? ` (${board.completedTaskCount} done)` : '');
    const tag = board.tags?.includes('🎯')
      ? ' 🎯'
      : board.tags?.some((t: string) => t.startsWith('goal:'))
        ? ' 🎯'
        : '';
    rows.push(`  ${title.padEnd(titleWidth)}  ${id}  ${taskInfo}${tag}`);
  }

  const parts = [...header, ...rows];
  if (tagMarker) {
    parts.push('', '  🎯 = goal/SDD-linked board');
  }
  parts.push('', '  Use `/kanban` to open the interactive panel.');
  return parts.join('\n');
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, max);
  return text.slice(0, max - 1) + '…';
}
