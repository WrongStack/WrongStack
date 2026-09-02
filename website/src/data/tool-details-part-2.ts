// Per-tool detail data for the built-in tool detail pages.
// Generated from the real tool definitions in @wrongstack/tools (name, description,
// inputSchema, selection boundaries). Keys match runtime-catalog.ts toolCatalog names.

import type { ToolDetail } from './tool-detail-types';

export const toolDetailsPart2: Record<string, ToolDetail> = {
  browser_close: {
    longDescription:
      'Close an owned browser session, reclaim its context, and return sensitive trace metadata.',
    params: [
      {
        name: 'sessionId',
        type: 'string',
        required: true,
        description: 'Browser session id returned by browser_open.',
      },
    ],
  },
  e2e_plan: {
    longDescription:
      'Discover Playwright and Cypress projects and preview bounded E2E execution plans without loading configs or starting processes.',
    params: [
      {
        name: 'cwd',
        type: 'string',
        description: 'Directory inside the project to inspect.',
      },
      {
        name: 'framework',
        type: "'all' | 'playwright' | 'cypress'",
        description: 'Optional framework filter; defaults to all.',
      },
      {
        name: 'maxDepth',
        type: 'integer',
        description: 'Maximum workspace discovery depth; defaults to 5.',
      },
      {
        name: 'includeSpecs',
        type: 'boolean',
        description: 'Count and sample specs; defaults to true.',
      },
    ],
    notes: [
      'Use before running browser E2E tests. The result identifies authoritative configs, package scripts, static server hints, specs, and exact argv.',
    ],
  },
  read: {
    longDescription:
      'Read the contents of a file with line numbers. This is the primary way to inspect source code, configuration, or any text file before making changes. Lines are returned 1-indexed in the form `N→content` (line number, then a `→` separator, then the raw line); the prefix is display-only and must be stripped before reusing the text in edits.',
    params: [
      {
        name: 'path',
        type: 'string',
        required: true,
        description: 'Path to the file (relative to project root or absolute within project).',
      },
      {
        name: 'offset',
        type: 'integer',
        description: '1-based starting line number. Use together with `limit` for large files.',
      },
      {
        name: 'limit',
        type: 'integer',
        description: 'Maximum number of lines to return (default 2000, clamped to 5000 max).',
      },
      {
        name: 'mode',
        type: "'content' | 'summary'",
        description:
          'Return full line-numbered content (default) or a compact file summary with imports/exports/symbols.',
      },
    ],
    doNotUseWhen: ['you need to search many files for matching content.'],
    useInstead: ['grep'],
    notes: [
      'Always read a file before using `edit`, `replace`, or `write` on it (the system often requires it for safety).',
      'Use `offset` + `limit` for very large files instead of reading everything at once.',
      'Default limit is generous (2000 lines) but can be increased.',
      'Output is capped at 256 KiB.',
    ],
  },
  write: {
    longDescription:
      'Write or completely overwrite a file on disk. This is a high-privilege operation. For modifying existing files, you should almost always prefer the `edit` tool instead, because `edit` is safer and works on the last-read version of the file.',
    params: [
      {
        name: 'path',
        type: 'string',
        required: true,
        description: 'Relative path from project root. Must not escape the project.',
      },
      {
        name: 'content',
        type: 'string',
        required: true,
        description: 'The complete new content of the file.',
      },
    ],
    doNotUseWhen: ['making a precise change to part of an existing file.'],
    useInstead: ['edit'],
    notes: [
      'Use `write` primarily for new files or when you want to replace the entire content.',
      'For any existing file, strongly prefer `edit` (it requires a prior `read` in the same session and is more precise).',
      'When overwriting an existing file, the tool reads the current content itself to compute the diff — but still `read` the file first before large rewrites so you know what you are replacing.',
      'When overwriting an existing file, the content is normalized to the dominant line-ending style (CRLF/LF) of the existing file; new files are written verbatim.',
    ],
  },
  edit: {
    longDescription:
      'Perform a precise, surgical text replacement in a file. This is the preferred tool for modifying existing code. It works best after a prior `read`, but can auto-read the current file when the replacement is still unambiguous.',
    params: [
      {
        name: 'path',
        type: 'string',
        required: true,
      },
      {
        name: 'old_string',
        type: 'string',
        required: true,
      },
      {
        name: 'new_string',
        type: 'string',
        required: true,
      },
      {
        name: 'replace_all',
        type: 'boolean',
      },
    ],
    doNotUseWhen: [
      'creating a new file, replacing the whole file, or applying an existing unified diff.',
    ],
    useInstead: ['write', 'patch'],
    notes: [
      'Prefer calling `read` on the target file first when planning an edit.',
      'Use a sufficiently unique `old_string` (include surrounding lines/context if needed).',
      'If the string appears multiple times and you want to change all of them, set `replace_all: true`.',
    ],
  },
  replace: {
    longDescription:
      'Perform a search-and-replace across multiple files using a regex pattern. This is a powerful bulk transformation tool. Dry-run is ON by default — set `dry_run: false` to apply changes.',
    params: [
      {
        name: 'pattern',
        type: 'string',
        required: true,
        description: 'Regex pattern to match',
      },
      {
        name: 'replacement',
        type: 'string',
        required: true,
        description: 'Replacement string',
      },
      {
        name: 'files',
        type: 'string',
        required: true,
        description: 'File(s) to target: single path, comma-separated list, or glob pattern',
      },
      {
        name: 'glob',
        type: 'string',
        description: 'Additional glob filter (e.g. "*.ts")',
      },
      {
        name: 'replace_all',
        type: 'boolean',
        description: 'Replace all occurrences in each file (default: true)',
      },
      {
        name: 'dry_run',
        type: 'boolean',
        description: 'Preview changes without writing (default: true)',
      },
    ],
    notes: [
      'Run without `dry_run: false` first to see exactly what would change (dry-run is the default).',
      'Review the diff output, then re-run with `dry_run: false` to apply.',
      'Use a specific enough `pattern` (and `glob` / `files`) to avoid accidental broad changes.',
    ],
  },
  glob: {
    longDescription:
      'Find files matching a glob pattern. Fast way to discover relevant files before reading, grepping, or editing them.',
    params: [
      {
        name: 'pattern',
        type: 'string',
        required: true,
        description: 'Glob pattern to match (e.g. "**/*.ts", "src/**").',
      },
      {
        name: 'path',
        type: 'string',
        description: 'Base directory to search from (defaults to project root).',
      },
      {
        name: 'limit',
        type: 'integer',
        description: 'Maximum number of results to return (default 1000, max 5000).',
      },
    ],
    doNotUseWhen: ['you need to search inside file contents.'],
    useInstead: ['grep'],
    notes: [
      'Use early to get a list of files you actually care about.',
      'Combine with `path` and `limit`.',
      'Default ignores common build/dependency directories.',
      'Output is capped at 64 KiB.',
    ],
  },
  grep: {
    longDescription:
      'Search across files using a regular expression. This is one of the primary code search tools. Prefers ripgrep for speed and features when available.',
    params: [
      {
        name: 'pattern',
        type: 'string',
        required: true,
        description: 'Regular expression pattern to search for in file contents.',
      },
      {
        name: 'path',
        type: 'string',
        description: 'Limit search to this directory or file (relative to project root).',
      },
      {
        name: 'glob',
        type: 'string',
        description: 'Glob filter for which files to include (e.g. "**/*.ts", "src/**").',
      },
      {
        name: 'output_mode',
        type: "'content' | 'files_with_matches' | 'count'",
        description: 'Return style: detailed matches, just file list, or count only.',
      },
      {
        name: 'context_lines',
        type: 'integer',
        description: 'How many lines of surrounding context to include with each match.',
      },
      {
        name: 'case_insensitive',
        type: 'boolean',
        description: 'Ignore case when matching.',
      },
      {
        name: 'limit',
        type: 'integer',
        description: 'Maximum number of matches to return.',
      },
    ],
    doNotUseWhen: ['you only need to locate files by name or path pattern.'],
    useInstead: ['glob'],
    notes: [
      '`pattern` is a regular expression.',
      'Use `output_mode: "content"` (default) to get matching lines with context.',
      'Use `"files_with_matches"` when you only need the list of files.',
      'Output is capped at 128 KiB.',
    ],
  },
  bash: {
    longDescription:
      "Execute an arbitrary command in the user's default shell (bash/zsh/pwsh/cmd). stdout and stderr are merged into one stream. This is the most powerful and dangerous tool — it gives the model full access to the developer's machine. Prefer specialized tools whenever possible.",
    params: [
      {
        name: 'command',
        type: 'string',
        required: true,
        description: 'The exact shell command to run. Prefer simple, focused commands.',
      },
      {
        name: 'timeout_ms',
        type: 'integer',
        description: 'Optional timeout for this specific command in milliseconds.',
      },
      {
        name: 'background',
        type: 'boolean',
        description:
          'If true, launch the process in the background and return the PID immediately.',
      },
    ],
    doNotUseWhen: [
      'the command is allowlisted and does not require pipes, redirection, or shell expansion.',
    ],
    useInstead: ['exec'],
    notes: [
      'Strongly prefer `exec` for known safe commands (node, npm, pnpm, tsc, git, etc.).',
      'Use bash only when you genuinely need shell features (pipes, redirection, complex one-liners).',
      'Prefer single focused commands over huge `&&` chains.',
      'Output is capped at 32 KiB.',
    ],
  },
  exec: {
    longDescription:
      'Execute a **whitelisted, restricted set of commands** with strict argument validation. This is the **preferred and safer** alternative to the `bash` tool for running development tools (node, npm, pnpm, tsc, git, tests, linters, etc.). It prevents arbitrary command injection and limits what the model can do.',
    params: [
      {
        name: 'command',
        type: 'string',
        required: true,
        description:
          'The base command to run. Must be in the internal allowlist (e.g. "node", "pnpm", "git", "tsc").',
      },
      {
        name: 'args',
        type: 'string[]',
        description: 'Arguments passed to the command. Passed as an array (no shell parsing).',
      },
      {
        name: 'cwd',
        type: 'string',
        description: 'Optional working directory. Must resolve inside the project root.',
      },
      {
        name: 'timeout',
        type: 'integer',
        description: 'Per-command timeout in milliseconds.',
      },
    ],
    doNotUseWhen: [
      'the operation requires pipes, redirection, shell expansion, or a non-allowlisted command.',
    ],
    useInstead: ['bash'],
    notes: [
      '`command` must be in the allowlist. Defaults cover JS (node/npm/pnpm/yarn/bun/deno/tsc/vitest/eslint/biome), Go (`go build`/`go test`), Rust (cargo), Python (python/pip), Ruby (gem/bundle), JVM (java/mvn/gradle), .NET (dotnet), native (make/cmake), and git. Users can extend it via `tools.exec.allow` in config.',
      'Arguments are passed as a clean array (no shell interpretation).',
      '`cwd` is validated to stay inside the project.',
    ],
  },
  pwsh: {
    longDescription:
      'Execute a PowerShell command (`pwsh -Command`) in a fresh process on Windows and return its stdout/stderr. Stateless per call: pass `workdir` instead of using `cd`.',
    params: [
      {
        name: 'command',
        type: 'string',
        required: true,
        description: 'The exact PowerShell command or script block to run.',
      },
      {
        name: 'workdir',
        type: 'string',
        description:
          'Absolute or project-relative path to the working directory for this command. Defaults to session working directory.',
      },
      {
        name: 'timeout_ms',
        type: 'integer',
        description:
          'Optional timeout for this specific command in milliseconds (default 300000, max 600000).',
      },
      {
        name: 'run_in_background',
        type: 'boolean',
        description:
          'If true, launch the process in the background and return the job ID / PID immediately.',
      },
      {
        name: 'background',
        type: 'boolean',
        description: 'Alias for run_in_background.',
      },
      {
        name: 'sandbox_permissions',
        type: 'string',
        description:
          'Escalation mode if retrying a sandbox-denied command (e.g., workspace-write).',
      },
      {
        name: 'justification',
        type: 'string',
        description:
          'One-sentence justification when retrying a denied command with sandbox_permissions.',
      },
    ],
    doNotUseWhen: [
      'the command is an allowlisted single binary (node, git, pnpm, tsc) needing no shell expansion or pipelines.',
    ],
    useInstead: ['exec'],
    notes: [
      'Stateless: No cwd, variables, or functions persist between calls. Use `workdir` to set the directory.',
      'Paths & Environs: Use native Windows paths (`C:\\...`) and read env vars via `$env:NAME` (and `$env:DSH_*`).',
      'Sandboxing: Under read-only sandbox, pwsh runs in `ConstrainedLanguage` mode. Workspace-write runs in `FullLanguage`.',
      'Background: Set `run_in_background: true` for long-running processes (returns job id; manage via job_output/job_kill).',
      'Output is capped at 32 KiB.',
    ],
  },
  fetch: {
    longDescription:
      'Fetch a URL and return its content. HTML pages are automatically converted to clean markdown. This tool has strong SSRF protections (private IPs, localhost, and cloud metadata endpoints are blocked by default).',
    params: [
      {
        name: 'url',
        type: 'string',
        required: true,
        description: 'The target URL (must use https://).',
      },
      {
        name: 'format',
        type: "'markdown' | 'text' | 'raw'",
        description: 'Output format. "markdown" is recommended for HTML pages.',
      },
    ],
    notes: [
      'Only HTTPS is allowed by default.',
      'Internal/private networks are blocked unless explicitly enabled via environment variable.',
      'Redirects are followed but re-validated at each hop.',
      'Output is capped at 128 KiB.',
    ],
  },
  search: {
    longDescription:
      'Perform a web search and return results with title, URL, and snippet. Use this when you need up-to-date external information that is not in the local codebase. Results are cached (5 min TTL) and deduplicated by URL.',
    params: [
      {
        name: 'query',
        type: 'string',
        required: true,
        description: 'Search query',
      },
      {
        name: 'num_results',
        type: 'integer',
        description: 'Number of results (1-50, default 10)',
      },
      {
        name: 'source',
        type: "'duckduckgo' | 'google' | 'bing'",
        description: 'Search engine to use (default: duckduckgo)',
      },
      {
        name: 'skip_cache',
        type: 'boolean',
        description: 'Skip the in-memory cache and force a fresh search (default: false)',
      },
    ],
    notes: [
      'Prefer specific queries over very broad ones.',
      'Results go through the guarded fetch system (same protections as the `fetch` tool).',
      'Supports duckduckgo (default), google, and bing sources.',
    ],
  },
  todo: {
    longDescription:
      'Manage the session-level todo list. This is the primary mechanism for tracking multi-step work. The list is fully replaced on every call (not appended).',
    params: [
      {
        name: 'todos',
        type: 'object[]',
        required: true,
        description: 'The complete new list of todos. This replaces the previous list entirely.',
      },
    ],
    notes: [
      'At the beginning of a non-trivial task, create a clear todo list with specific, actionable items.',
      'Only one item should be `in_progress` at any time.',
      'Update the list frequently as work progresses (mark items done, add new ones, change status).',
    ],
  },
  plan: {
    longDescription:
      'Manage a session-persistent strategic plan. The plan is written to disk and survives conversation resumptions within the same session, but is isolated to this session — other sessions have their own separate plans. Unlike todos (which are per-turn and lost on restart), a plan tracks high-level progress across multiple turns.',
    params: [
      {
        name: 'action',
        type: "'show' | 'add' | 'start' | 'done' | 'remove' | 'promote' | 'template_use' | 'clear' | 'taskify'",
        required: true,
        description: 'The operation to perform on the plan board.',
      },
      {
        name: 'title',
        type: 'string',
        description: 'Title of the plan item. Required for action=add.',
      },
      {
        name: 'details',
        type: 'string',
        description: 'Additional details or description for a new plan item (action=add).',
      },
      {
        name: 'target',
        type: 'string',
        description:
          'Identifier for the target plan item (id, 1-based index, or partial title). Required for most actions except add/show/clear.',
      },
      {
        name: 'subtasks',
        type: 'string[]',
        description:
          'List of subtask titles. Used with promote to break a plan item into multiple todos.',
      },
      {
        name: 'template',
        type: 'string',
        description:
          'Template identifier when using action=template_use. Common values: new-feature, bug-fix, refactor, release, security-audit.',
      },
      {
        name: 'scope',
        type: "'session' | 'project'",
        description:
          'Storage scope: "session" (default, isolated to this session) or "project" (shared across all sessions for this project).',
      },
    ],
    notes: [
      'Start by creating a high-level plan with `action: "add"` or using templates (`template_use`).',
      'Use `promote` to turn a plan item into actionable todos.',
      'Use `taskify` to convert a plan item into a structured task (with type/priority/deps).',
    ],
  },
  kanban: {
    longDescription:
      'Manage project-scoped multi-kanban boards stored under .wrongstack/kanbans. Supports board/task CRUD, ready-task queues, dependency chains, split/merge, assignment metadata, provider/model/fallback routing hints, goal metrics, success checks, notes, links, and run status updates.',
    params: [
      {
        name: 'action',
        type: "'list_boards' | 'get_board' | 'create_board' | 'duplicate_board' | 'update_board' | 'delete_board' | 'generate_board' | 'export_markdown' | 'export_task_graph' | 'sync_task_graph' | 'search_tasks' | 'ready_tasks' | 'snapshot' | 'add_task' | 'split_task' | 'merge_tasks' | 'copy_task' | 'transfer_task' | 'get_task' | 'update_task' | 'move_task' | 'delete_task' | 'set_chain' | 'get_chain' | 'claim_task' | 'release_task' | 'assign_task' | 'mark_assignment' | 'heartbeat_assignment' | 'recover_stale' | 'events' | 'queue_health' | 'add_dependency' | 'add_goal_metric' | 'update_goal_metric' | 'add_check' | 'update_check' | 'add_note' | 'add_link'",
        required: true,
      },
      {
        name: 'boardId',
        type: 'string',
      },
      {
        name: 'taskId',
        type: 'string',
      },
      {
        name: 'taskIds',
        type: 'string[]',
      },
      {
        name: 'chainId',
        type: 'string',
      },
      {
        name: 'columnId',
        type: 'string',
      },
      {
        name: 'targetBoardId',
        type: 'string',
      },
      {
        name: 'targetColumnId',
        type: 'string',
      },
      {
        name: 'title',
        type: 'string',
      },
      {
        name: 'description',
        type: 'string',
      },
      {
        name: 'tags',
        type: 'string[]',
      },
      {
        name: 'labels',
        type: 'string[]',
      },
      {
        name: 'priority',
        type: "'critical' | 'high' | 'medium' | 'low'",
      },
      {
        name: 'status',
        type: "'pending' | 'ready' | 'in_progress' | 'blocked' | 'review' | 'completed' | 'failed' | 'archived'",
      },
      {
        name: 'order',
        type: 'number',
      },
      {
        name: 'query',
        type: 'string',
      },
      {
        name: 'limit',
        type: 'number',
      },
      {
        name: 'agentId',
        type: 'string',
      },
      {
        name: 'name',
        type: 'string',
      },
      {
        name: 'role',
        type: 'string',
      },
      {
        name: 'provider',
        type: 'string',
      },
      {
        name: 'model',
        type: 'string',
      },
      {
        name: 'fallbackProfile',
        type: 'string',
      },
      {
        name: 'fallbackModels',
        type: 'string[]',
      },
      {
        name: 'tools',
        type: 'string[]',
      },
      {
        name: 'allowedCapabilities',
        type: 'string[]',
      },
      {
        name: 'leaseId',
        type: 'string',
      },
      {
        name: 'claimedAt',
        type: 'string',
      },
      {
        name: 'heartbeatAt',
        type: 'string',
      },
      {
        name: 'leaseExpiresAt',
        type: 'string',
      },
      {
        name: 'attempt',
        type: 'number',
      },
      {
        name: 'maxAttempts',
        type: 'number',
      },
      {
        name: 'subagentId',
        type: 'string',
      },
      {
        name: 'runTaskId',
        type: 'string',
      },
      {
        name: 'lastResult',
        type: 'string',
      },
      {
        name: 'error',
        type: 'string',
      },
      {
        name: 'assignmentStatus',
        type: "'assigned' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'",
      },
      {
        name: 'releaseStatus',
        type: "'pending' | 'ready' | 'blocked'",
      },
      {
        name: 'releaseReason',
        type: 'string',
      },
      {
        name: 'clearAssignee',
        type: 'boolean',
      },
      {
        name: 'recoveryMode',
        type: "'release' | 'retry' | 'fail'",
      },
      {
        name: 'recoveryNow',
        type: 'string',
      },
      {
        name: 'taskGraph',
        type: 'object',
      },
      {
        name: 'graphId',
        type: 'string',
      },
      {
        name: 'specId',
        type: 'string',
      },
      {
        name: 'sourceSystem',
        type: 'string',
      },
      {
        name: 'phaseId',
        type: 'string',
      },
      {
        name: 'preserveOriginTaskIds',
        type: 'boolean',
      },
      {
        name: 'includeArchived',
        type: 'boolean',
      },
      {
        name: 'archiveMissingTasks',
        type: 'boolean',
      },
      {
        name: 'preserveManualDependencies',
        type: 'boolean',
      },
      {
        name: 'dependencyTaskId',
        type: 'string',
      },
      {
        name: 'enforceDependencies',
        type: 'boolean',
      },
      {
        name: 'childTitles',
        type: 'string[]',
      },
      {
        name: 'inheritAssignment',
        type: 'boolean',
      },
      {
        name: 'inheritLabels',
        type: 'boolean',
      },
      {
        name: 'inheritSuccessCriteria',
        type: 'boolean',
      },
      {
        name: 'inheritGoalMetrics',
        type: 'boolean',
      },
      {
        name: 'inheritDependencies',
        type: 'boolean',
      },
      {
        name: 'chainChildren',
        type: 'boolean',
      },
      {
        name: 'rewireDependents',
        type: 'boolean',
      },
      {
        name: 'closeSourceTasks',
        type: 'boolean',
      },
      {
        name: 'metricId',
        type: 'string',
      },
      {
        name: 'metricName',
        type: 'string',
      },
      {
        name: 'metricTarget',
        type: 'string | number',
      },
      {
        name: 'metricCurrent',
        type: 'string | number',
      },
      {
        name: 'metricUnit',
        type: 'string',
      },
      {
        name: 'metricStatus',
        type: "'pending' | 'met' | 'missed' | 'waived'",
      },
      {
        name: 'metricNotes',
        type: 'string',
      },
      {
        name: 'checkId',
        type: 'string',
      },
      {
        name: 'checkDescription',
        type: 'string',
      },
      {
        name: 'checkStatus',
        type: "'pending' | 'passed' | 'failed' | 'skipped'",
      },
      {
        name: 'note',
        type: 'string',
      },
      {
        name: 'author',
        type: 'string',
      },
      {
        name: 'url',
        type: 'string',
      },
      {
        name: 'linkTitle',
        type: 'string',
      },
      {
        name: 'linkType',
        type: "'issue' | 'pr' | 'doc' | 'commit' | 'design' | 'file' | 'url' | 'other'",
      },
      {
        name: 'context',
        type: 'string',
      },
      {
        name: 'columns',
        type: 'string[]',
      },
      {
        name: 'generatedBy',
        type: 'string',
      },
      {
        name: 'includeTasks',
        type: 'boolean',
      },
      {
        name: 'includeCompletedTasks',
        type: 'boolean',
      },
      {
        name: 'preserveAssignment',
        type: 'boolean',
      },
      {
        name: 'preserveDependencies',
        type: 'boolean',
      },
      {
        name: 'moveTasksToColumnId',
        type: 'string',
      },
    ],
    notes: [
      'Use this for durable project kanban state. Agents should call snapshot/ready_tasks, then claim_task before working.',
    ],
  },
};
