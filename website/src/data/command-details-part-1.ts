import type { CommandDetailMap } from './command-detail-types';

export const commandDetailsPart1: CommandDetailMap = {
  '/btw': {
    purpose:
      'Ask a quick side question without derailing the current task or polluting the main conversation thread.',
    behavior:
      'The command opens a lightweight side-channel. Your question is answered inline but does not become part of the main task context — the agent returns to its primary objective immediately after answering. Ideal for clarifying syntax, checking a fact, or getting a quick lookup without context pollution.',
    before: 'No preparation needed. Just have your question ready.',
    during:
      'The agent pauses its main task briefly, answers your question, then resumes. The side answer appears inline.',
    after:
      'The main task continues uninterrupted. The side Q&A is logged but does not steer the primary workflow.',
  },

  '/next': {
    purpose:
      'Toggle automatic next-task prediction — the agent suggests what to do after the current task completes.',
    behavior:
      'When enabled, after each task completion the agent appends 2–4 suggested next prompts in a <nextsteps> block. You select one with `/next 1` (or `/next 1 2 3`), list them with `/next list`, or regenerate with `/suggest`. Running `/next` without arguments toggles the feature on or off.',
    before:
      'Check whether you want predictive suggestions for your workflow style. Some users prefer manual control.',
    during:
      'If toggling on, observe the next task completion — suggestions appear at the end of the agent response.',
    after:
      'Use `/next list` to see available suggestions or `/next 1` to select one. Disable with another `/next` if it gets distracting.',
  },

  '/suggest': {
    purpose:
      'Generate context-aware next actions manually, with an optional fast heuristic mode that skips the model call.',
    behavior:
      'The command analyzes your current session context — open files, recent tasks, mailbox messages, and todo list — and produces a ranked list of suggested next prompts. In heuristic mode it uses pattern matching for speed; without it, the configured model generates richer suggestions.',
    before: 'Complete or pause your current task so the context reflects what remains to be done.',
    during:
      'Suggestions appear as a numbered list. Heuristic mode returns near-instantly; model mode may take a few seconds.',
    after: 'Type `/next <number>` to select a suggestion or `/next list` to review them again.',
  },

  '/enhance': {
    purpose:
      'Refine a prompt before it is sent to the agent — improve clarity, add missing context, or rephrase for better results.',
    behavior:
      'The command takes your raw prompt and runs it through a refinement pass. The model expands vague instructions, adds relevant context from the session, and sharpens the ask. You see the enhanced version and can accept it, edit it, or discard it before it reaches the agent.',
    before:
      'Write a rough prompt — even a few words will do. The enhancer works best when you give it a clear goal statement.',
    during:
      'The refined prompt appears for your review. You can accept it as-is, edit it inline, or cancel.',
    after:
      'The accepted prompt is sent to the agent. If you edited it, your version is used. If cancelled, nothing is sent.',
  },

  '/fix': {
    purpose:
      'Classify an error and route it into a focused repair workflow — faster than explaining the bug manually.',
    behavior:
      'The command reads the most recent error from the session (or accepts a pasted error), classifies it by type (type error, lint, test failure, runtime crash), and dispatches a targeted repair sub-agent with the appropriate tools and context. The fixer proposes a patch you can review.',
    before:
      'Keep the error message handy — copy it from your terminal or let the command read the last session error.',
    during:
      'The classifier identifies the error type, then a repair workflow runs. You see diagnostic output and the proposed fix.',
    after:
      'Review the diff. Run tests to confirm the fix. If the classifier misidentified the error, re-run with a pasted error message.',
  },

  '/goal': {
    purpose:
      'Set, show, pause, resume, journal, or clear an autonomous mission that the agent works toward across turns. The eternal / parallel engines keep the goal, its Kanban board, and the Brain council in sync through adaptive coordination — when every deliverable is complete and the Brain confirms `goal reached`, the loop stops and `goal.json` records the verdict.',
    behavior:
      'A goal is a persistent, high-level objective the agent keeps in context. `/goal set "..."` creates one and seeds a matching Kanban board with one card per deliverable. While `/autonomy eternal` runs, the agent emits `[DONE: <index>]` or `[DONE: <text-prefix>]` markers in its output to mark deliverables complete; the coordinator moves each card to Done, recomputes progress deterministically (ratio of completed deliverables), and consults Brain exactly once when the checklist reaches 100%. A `goal_reached` verdict stops the loop with `goal reached` recorded; a `keep_working` verdict leaves the goal active at 100% so the next iteration can re-attempt. `/goal pause` suspends it; `/goal resume` reactivates it; `/goal journal` shows progress; `/goal clear` removes it.',
    before:
      'Formulate a concrete, achievable mission statement. Goals work best when they are scoped to a session or a few sessions. List the deliverables you expect the agent to finish — the engine uses them for both the Kanban board and the progress bar.',
    during:
      'The goal appears in the status line and the agent references it when choosing next actions. The Kanban board auto-refreshes as the agent emits `[DONE:]` markers, and the progress bar reflects the completed-deliverable ratio. Brain is consulted exactly once per goal, at 100%, and the goal file is preserved (never deleted) so the verdict survives reloads.',
    after:
      'Use `/goal journal` to review progress. The final state of a reached goal — including the `reachedAt` timestamp and the `goal reached` note — stays in `goal.json`; clear it with `/goal clear` only when you want to start a fresh mission.',
  },

  '/autonomy': {
    purpose:
      'Set the active autonomy level — control how independently the agent chooses and executes tasks.',
    behavior:
      'Autonomy levels range from manual (you drive every step) to full (the agent plans and executes freely). `/autonomy` without arguments shows the current level. `/autonomy <level>` sets it. Higher levels unlock automatic task chaining, goal pursuit, and proactive tool use.',
    before:
      'Decide how much control you want to retain. Higher autonomy is powerful but requires trust in the agent judgment.',
    during:
      'The new level takes effect immediately. The status line updates to reflect the change.',
    after:
      'Observe the agent behavior for a few turns. Lower autonomy if it overreaches; raise it if you want less micromanagement.',
  },

  '/plan': {
    purpose:
      'Manage the per-session strategic plan board — outline big-picture work and track progress across turns.',
    behavior:
      'The plan is a durable outline that survives within the session. `/plan add "title"` creates an item. `/plan start <id>` marks it in progress. `/plan done <id>` completes it. `/plan promote <id>` breaks a plan item into todo items. Plans can be session-scoped or project-scoped.',
    before:
      'Think about the high-level milestones for your session. Plans are coarser than todos — they represent phases or features.',
    during: 'The plan board prints after each mutation. Active items show their status.',
    after:
      'Use `/plan promote` to convert completed plan items into actionable todos for detailed execution.',
  },

  '/review': {
    purpose:
      'Run a model-driven code review pass — the agent inspects your changes and reports issues, risks, and suggestions.',
    behavior:
      'The command runs the configured model over your working tree diff (or specified files). It checks for bugs, anti-patterns, security issues, style violations, and design problems. The output is a structured review with severity levels and actionable suggestions.',
    before:
      'Stage or diff the changes you want reviewed. Narrow the scope with a file path for faster, more focused reviews.',
    during:
      'The review runs as a focused model pass. It produces a categorized report with file references and severity tags.',
    after:
      'Address critical and high-severity findings. Re-run the review after fixes to confirm resolution.',
  },

  '/kanban': {
    purpose:
      'Manage durable Kanban boards — create columns, add dependency-aware tasks, assign work, and dispatch to the fleet.',
    behavior:
      'The full Kanban system supports multiple boards, columns, tasks with dependency chains, assignments, leases, heartbeats, and fleet dispatch. `/kanban` opens the TUI panel. Subcommands like `/kanban task ready`, `/kanban task dispatch`, and `/kanban snapshot` provide CLI access. Aliases: `/kb`, `/board`.',
    before:
      'Create a board with columns matching your workflow (e.g., Todo, Running, Review, Done). Define task dependencies before dispatching.',
    during:
      'The TUI panel shows live column state. Dispatched tasks appear in the fleet with lease tracking.',
    after:
      'Run `/kanban snapshot` to persist board state. Recover stale tasks with `/kanban task recover`.',
  },

  '/refiner': {
    purpose:
      'Inspect and tune automatic prompt-refinement behavior — control how the agent polishes prompts before execution.',
    behavior:
      'The refiner automatically enhances prompts before they reach the agent. `/refiner` shows current settings. You can adjust the refinement level, enable/disable it, or configure which prompt types get refined. Works alongside `/enhance` for manual refinement.',
    before:
      'Understand your refinement preferences. Aggressive refinement may change your intent; light refinement only fixes clarity.',
    during:
      'Settings take effect immediately. Future prompts are refined according to the new configuration.',
    after: 'Test with a sample prompt to verify the refinement level matches your expectations.',
  },

  '/compact': {
    purpose:
      'Run the configured context-window compactor immediately — reclaim token space without losing essential context.',
    behavior:
      'The compactor summarizes older messages, prunes irrelevant content, and consolidates the conversation into a denser form. It preserves key decisions, file references, and active tasks. Run it proactively when approaching context limits or when the conversation feels bloated.',
    before:
      'Check current context usage with `/context` or `/stats`. Compact when you are above 70% of the window.',
    during:
      'The compaction runs as a model pass. It may take a few seconds. A summary note is injected post-compaction.',
    after:
      'Review the compaction summary to ensure no critical context was lost. Continue working — the agent remembers the essentials.',
  },

  '/context': {
    purpose:
      'Inspect, repair, and tune context modes, thresholds, and limits — control how the agent manages its working memory.',
    behavior:
      '`/context` shows the current context window state: token usage, message count, compaction thresholds. Subcommands let you switch context modes (deep, balanced, tight), adjust compaction thresholds, manually prune message ranges, and inject summary notes. The `/ctx` alias works interchangeably.',
    before:
      'Check `/stats` first for a quick overview. Use `/context` when you need to inspect or modify the context strategy.',
    during:
      'The command output shows the live context state. Mode switches and threshold changes apply immediately.',
    after:
      'Monitor context usage over the next few turns to confirm the new settings work for your workflow.',
  },

  '/diag': {
    purpose:
      'Inspect runtime diagnostics and active system state — a comprehensive health check for the current session.',
    behavior:
      'The command prints a structured diagnostics report: Node.js version, process uptime, memory usage, active plugins, loaded skills, registered tools, provider status, session metrics, and any detected anomalies. Use it when something feels wrong or before reporting a bug.',
    before: 'No preparation needed. Run it anytime you want a system health snapshot.',
    during:
      'The report prints section by section. Each section is labeled and can be visually scanned for warnings.',
    after:
      'Address any warnings or errors shown in the report. Share the output when filing a bug report.',
  },

  '/stats': {
    purpose:
      'Show token, cost, and iteration statistics for the current session — understand where your budget is going.',
    behavior:
      'The command prints a breakdown: total tokens used (input vs output), estimated cost, iteration count, tool call count, and averages per turn. Some providers expose more detail than others. The stats reset when you start a new session.',
    before:
      'No preparation needed. Run it to check your usage against provider limits or cost concerns.',
    during: 'The stats print instantly — no model call required.',
    after:
      'If costs are high, consider switching to a cheaper model with `/setmodel` or compacting with `/compact`.',
  },

  '/memory': {
    purpose: 'Search, graph, verify, clean, import, and inspect the structured Sage system.',
    behavior:
      'Sage persists facts across sessions. `/memory search <query>` finds relevant memories. `/memory graph` shows the knowledge graph. `/memory verify` checks integrity. `/memory hygiene` cleans stale entries. `/memory import` loads from external sources. The memory system auto-injects relevant facts into agent context.',
    before:
      'Think about what you want to find or manage. Use search for fact retrieval, graph for relationship exploration.',
    during:
      'Search results show relevance scores. Graph view shows nodes and edges. Hygiene operations show what was cleaned.',
    after:
      'Verified memories are more reliable. After importing, search to confirm the data landed correctly.',
  },

  '/todos': {
    purpose: 'View and manage the current session todo list — the agent tactical task tracker.',
    behavior:
      'The todo list is the agent per-turn task list. `/todos` prints all items with their status (pending, in_progress, completed). The agent updates it automatically as it works. You can add, remove, or reorder items manually. Unlike `/tasks`, todos are ephemeral and reset each session.',
    before: 'No preparation needed. Run it to see what the agent is currently working on.',
    during: 'The list prints with status indicators. Only one item can be in_progress at a time.',
    after: 'Completed items stay visible for the session. Use `/clear` to reset the todo list.',
  },

  '/tasks': {
    purpose:
      'Manage structured tasks with priorities, dependencies, types, and assignments — a richer alternative to todos.',
    behavior:
      'Tasks support types (feature, bugfix, refactor, docs, test, chore), priorities, dependency chains, assignees, and estimates. `/tasks` shows the full list. Tasks can be session-scoped or project-scoped. Use `/tasks promote` to convert a task into actionable todos.',
    before:
      'Plan your task hierarchy. Define dependencies before marking tasks ready to avoid blocked states.',
    during: 'The task list prints with type badges, priority indicators, and dependency arrows.',
    after: 'Completed tasks can be promoted to todos for detailed execution tracking.',
  },

  '/save': {
    purpose:
      'Force the live session writer to flush to disk — persist the current conversation state immediately.',
    behavior:
      'The session writer normally flushes periodically. `/save` forces an immediate write of the full conversation transcript, memory state, and session metadata to disk. Use it before a risky operation or before closing the terminal.',
    before: 'No preparation needed. It is safe to run at any time.',
    during: 'The flush happens synchronously — the prompt returns when the write is complete.',
    after:
      'Your session is now durable on disk. You can safely exit or resume later with `/sessions`.',
  },

  '/sessions': {
    purpose:
      'List and resume saved sessions — pick up where you left off, also available as `/resume` and `/load`.',
    behavior:
      'The command lists all saved sessions with timestamps, durations, and summary snippets. `/sessions resume <id>` restores a session with its full context, todo list, plan, and memory state. `/sessions rename <id> "name"` labels a session. `/sessions delete <id>` removes old sessions.',
    before: 'Save your current session with `/save` first if you plan to switch.',
    during:
      'The session list prints with IDs and metadata. Resuming loads the session and prints a restore summary.',
    after:
      'Verify the restored context is correct. The agent should remember your previous task and plan.',
  },

  '/prune': {
    purpose:
      'Preview or delete old session data — free disk space by removing stale transcripts and checkpoints.',
    behavior:
      '`/prune` shows a preview of which sessions are eligible for deletion based on age and size. `/prune --execute` performs the deletion. You can filter by age, project, or session count. Pruning is irreversible — the preview is always shown before deletion.',
    before:
      'Run `/prune` without flags first to preview what would be deleted. Confirm nothing important is in the list.',
    during: 'The preview lists sessions with size and age. The execute phase shows progress.',
    after: 'Run `/prune` again to confirm the old sessions are gone. Freed disk space is reported.',
  },

  '/exit': {
    purpose: 'Close the REPL cleanly — aliases include `/quit` and `/q`.',
    behavior:
      'The command triggers a graceful shutdown: the session is saved, active subagents are terminated, cron jobs are cancelled, and the process exits. Any unsaved changes are flushed before exit. Use this instead of Ctrl+C for a clean teardown.',
    before: 'Confirm you want to end the session. Any running fleet operations will be terminated.',
    during:
      'The shutdown sequence prints: saving session, stopping agents, cancelling timers, exiting.',
    after: 'The terminal returns to your shell. Your session is saved for later resume.',
  },

  '/interrupt': {
    purpose:
      'Abort the in-flight leader iteration safely — stop the agent mid-thought without corrupting session state.',
    behavior:
      'When the agent is in the middle of a model call or long tool execution, `/interrupt` sends a cancellation signal. The current operation stops gracefully, partial output is discarded, and the REPL prompt returns. Unlike Ctrl+C, it does not risk corrupting the session file.',
    before: 'Use when the agent is stuck, looping, or heading in the wrong direction.',
    during:
      'The interrupt signal propagates. In-flight tool calls may complete or abort depending on their phase.',
    after:
      'The REPL prompt returns. Review what the agent was doing and provide corrective steering.',
  },
};
