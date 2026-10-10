export const toolCategories = [
  'Browser & E2E',
  'Files & search',
  'Shell, Git & web',
  'Work & state',
  'Quality & language',
  'Dependencies & operations',
  'Generation & design',
  'Discovery & index',
] as const;

export type ToolCategory = (typeof toolCategories)[number];

export const toolCatalog = [
  {
    name: 'project_kit',
    summary:
      'Discover reusable project-specific tools before writing ad hoc scripts. Inspect contracts and guides, retrieve authoring templates, or read execution history without running project code.',
    permission: 'auto',
    mutating: false,
    category: 'Dependencies & operations',
  },
  {
    name: 'project_kit_run',
    summary:
      'Verify or run a revision-pinned Project Kit tool with schema-checked parameters in a tracked Node process. Executes arbitrary project code; verification also executes code and may have side effects.',
    permission: 'confirm',
    mutating: true,
    category: 'Dependencies & operations',
  },
  {
    name: 'tool_script',
    summary:
      'WrongStack ToolFlow: compose repetitive or deterministic dependent tool calls in sandboxed JavaScript, filter or compute over their results, and return compact findings for the next model decision. Call tools as async functions (`await tools.read({...})`, `tools.call(name, input)`). Each call retains validation, permissions, confirmations, and journaling. Prefer direct calls for simple operations or small independent batches. Model context receives the return, call summary, byte diagnostics, and console output, subject to normal preview/artifact handling. Speed and cost depend on the workflow and require separate measurements.',
    permission: 'auto',
    mutating: false,
    category: 'Discovery & index',
  },
  {
    name: 'browser_open',
    summary:
      'Create an isolated, agent-owned Playwright browser session, optionally opening an approved HTTP(S) URL. Missing Playwright/Chromium installs automatically. For trusted private or localhost targets, ask the operator to run /browser allow <origin> once for this project.',
    permission: 'confirm',
    mutating: true,
    category: 'Browser & E2E',
  },
  {
    name: 'browser_status',
    summary:
      'Check whether the managed Playwright Chromium installation is available before attempting browser automation.',
    permission: 'auto',
    mutating: false,
    category: 'Browser & E2E',
  },
  {
    name: 'browser_list',
    summary:
      'List browser sessions owned by this agent, including their state and current page, without exposing sessions owned by other agents.',
    permission: 'auto',
    mutating: false,
    category: 'Browser & E2E',
  },
  {
    name: 'browser_navigate',
    summary:
      'Navigate one of this agent’s browser sessions to an approved HTTP(S) URL. Use browser_open first. If private or localhost access is blocked, show the operator the exact /browser allow <origin> command from the error.',
    permission: 'confirm',
    mutating: true,
    category: 'Browser & E2E',
  },
  {
    name: 'browser_snapshot',
    summary:
      'Inspect the current page through a bounded accessibility snapshot, with redacted console and network summaries. Prefer this before interacting with page elements.',
    permission: 'auto',
    mutating: false,
    category: 'Browser & E2E',
  },
  {
    name: 'browser_screenshot',
    summary:
      'Capture a PNG of the current page or a selected element for visual QA. The result is a sensitive artifact with integrity metadata.',
    permission: 'confirm',
    mutating: true,
    category: 'Browser & E2E',
  },
  {
    name: 'browser_click',
    summary:
      'Click a verified page element in an owned browser session. Snapshot first and use the most specific stable selector available.',
    permission: 'confirm',
    mutating: true,
    category: 'Browser & E2E',
  },
  {
    name: 'browser_type',
    summary:
      'Fill a form control in an owned browser session. Use secretEnv for credentials so secret values never enter tool arguments or the audit trail.',
    permission: 'confirm',
    mutating: true,
    category: 'Browser & E2E',
  },
  {
    name: 'browser_select',
    summary:
      'Choose an option in a select control in an owned browser session after confirming the target selector and intended value.',
    permission: 'confirm',
    mutating: true,
    category: 'Browser & E2E',
  },
  {
    name: 'browser_press',
    summary:
      'Send a keyboard key or shortcut to an owned browser session, such as Enter after verifying a form is ready to submit.',
    permission: 'confirm',
    mutating: true,
    category: 'Browser & E2E',
  },
  {
    name: 'browser_hover',
    summary:
      'Hover over a verified page element in an owned browser session to reveal menus, tooltips, or other hover-driven UI state.',
    permission: 'confirm',
    mutating: true,
    category: 'Browser & E2E',
  },
  {
    name: 'browser_drag',
    summary:
      'Drag one page element onto another in an owned browser session. Use only when the page’s drag-and-drop interaction is the intended action.',
    permission: 'confirm',
    mutating: true,
    category: 'Browser & E2E',
  },
  {
    name: 'browser_wait',
    summary:
      'Wait for a selector, navigation condition, or bounded duration in an owned browser session before taking the next browser action.',
    permission: 'auto',
    mutating: false,
    category: 'Browser & E2E',
  },
  {
    name: 'browser_evaluate',
    summary:
      'Run a bounded JavaScript expression in an owned page when browser APIs cannot inspect the needed state. Treat page code as arbitrary and use sparingly.',
    permission: 'confirm',
    mutating: true,
    category: 'Browser & E2E',
  },
  {
    name: 'browser_upload',
    summary:
      'Upload project-local files through a page file input in an owned browser session. Verify both the file path and target control before uploading.',
    permission: 'confirm',
    mutating: true,
    category: 'Browser & E2E',
  },
  {
    name: 'browser_close',
    summary:
      'Close an owned browser session and reclaim its resources, returning trace-artifact metadata when tracing was enabled.',
    permission: 'auto',
    mutating: false,
    category: 'Browser & E2E',
  },
  {
    name: 'e2e_plan',
    summary:
      'Create an end-to-end test plan from a feature or user flow. Use it to identify scenarios and acceptance coverage; it plans tests rather than executing them.',
    permission: 'auto',
    mutating: false,
    category: 'Browser & E2E',
  },
  {
    name: 'read',
    summary:
      'Read a project file safely, with optional line ranges and binary-aware output. Use it to inspect source before editing; paths must stay within the project.',
    permission: 'auto',
    mutating: false,
    category: 'Files & search',
  },
  {
    name: 'read_url_content',
    summary:
      'Fetch content from a URL via HTTP request and convert HTML directly to clean markdown. Use for public docs and web pages without browser overhead.',
    permission: 'auto',
    mutating: false,
    category: 'Shell, Git & web',
  },
  {
    name: 'write',
    summary:
      'Create or replace one project file with the complete supplied content. Use for new files or intentional full rewrites, after reading existing content when applicable.',
    permission: 'confirm',
    mutating: true,
    category: 'Files & search',
  },
  {
    name: 'edit',
    summary:
      'Make a precise, guarded text edit by replacing an expected block in a project file. Prefer it for small source changes so mismatches prevent accidental overwrites.',
    permission: 'confirm',
    mutating: true,
    category: 'Files & search',
  },
  {
    name: 'replace',
    summary:
      'Preview or apply a regular-expression replacement across selected project files. Start with dry_run, constrain files and globs carefully, then apply only reviewed changes.',
    permission: 'confirm',
    mutating: true,
    category: 'Files & search',
  },
  {
    name: 'glob',
    summary:
      'Find project files by glob pattern, respecting repository boundaries and ignore rules. Use it to locate candidate paths before reading or editing them.',
    permission: 'auto',
    mutating: false,
    category: 'Files & search',
  },
  {
    name: 'grep',
    summary:
      'Search project text with a bounded regular expression and contextual matches. Use it for exact literals or patterns when semantic codebase search is not appropriate.',
    permission: 'auto',
    mutating: false,
    category: 'Files & search',
  },
  {
    name: 'bash',
    summary:
      'Run a shell command in the project with bounded output and timeout controls. Use it for development commands after checking side effects; background mode returns a process handle.',
    permission: 'confirm',
    mutating: true,
    category: 'Shell, Git & web',
  },
  {
    name: 'exec',
    summary:
      'Execute a command directly without shell interpretation, preserving every argument. YOLO/YOLO+ permit executables beyond the default roster, filesystem-scoped Git -C and temporary development settings; explicit tools.exec.deny entries still refuse. Prefer it for predictable process invocation.',
    permission: 'confirm',
    mutating: true,
    category: 'Shell, Git & web',
  },
  {
    name: 'pwsh',
    summary:
      'Execute a PowerShell command in the project with timeout, output, and background controls. Use it for Windows-native project operations and verify commands that can modify state.',
    permission: 'confirm',
    mutating: true,
    category: 'Shell, Git & web',
  },
  {
    name: 'fetch',
    summary:
      'Fetch and extract content from an approved HTTP(S) URL for research or integration work. Project origins allowed with /network allow (or /browser allow) are shared with the browser and HTTP reader. Use for a known page or endpoint.',
    permission: 'confirm',
    mutating: false,
    category: 'Shell, Git & web',
  },
  {
    name: 'search',
    summary:
      'Search the public web for current external information, then inspect selected results with fetch. Use it when repository evidence is insufficient or the fact may have changed.',
    permission: 'auto',
    mutating: false,
    category: 'Shell, Git & web',
  },
  {
    name: 'todo',
    summary:
      'Create, update, or list the session’s concrete work items and their progress. Use it to keep multi-step work visible; it does not implement the tasks itself.',
    permission: 'confirm',
    mutating: true,
    category: 'Work & state',
  },
  {
    name: 'plan',
    summary:
      'Create and manage higher-level plan-board items, priorities, and status. Use it for strategic work tracking rather than small immediate edits.',
    permission: 'confirm',
    mutating: true,
    category: 'Work & state',
  },
  {
    name: 'kanban',
    summary:
      'Manage project Kanban boards, cards, assignments, and acceptance evidence. Use it for persistent team workflow; changing board state is intentional and reviewable.',
    permission: 'confirm',
    mutating: true,
    category: 'Work & state',
  },
  {
    name: 'task',
    summary:
      'Manage structured task records, dependencies, ownership, and promotion into actionable session work. Use it to organize bounded work before delegation or execution.',
    permission: 'confirm',
    mutating: true,
    category: 'Work & state',
  },
  {
    name: 'git',
    summary:
      'Inspect or run scoped Git operations in the project, including status, diff, history, branches, and commits. Review the target and working tree before mutating operations.',
    permission: 'confirm',
    mutating: true,
    category: 'Shell, Git & web',
  },
  {
    name: 'patch',
    summary:
      'Apply a unified diff to project files with patch-style context checking. Use it for a reviewed multi-file change when exact patch content is available.',
    permission: 'confirm',
    mutating: true,
    category: 'Files & search',
  },
  {
    name: 'json',
    summary:
      'Read, query, validate, or merge JSON/JSON5/YAML files while preserving valid structure (read-only — does not write). Use it instead of raw text edits when reading or querying structured data.',
    permission: 'auto',
    mutating: false,
    category: 'Files & search',
  },
  {
    name: 'diff',
    summary:
      'Show file content with line numbers, staged/working-tree diffs via git, or commit/branch diffs. A safer and more structured alternative to raw `git diff` via shell.',
    permission: 'auto',
    mutating: false,
    category: 'Files & search',
  },
  {
    name: 'tree',
    summary:
      'Render a bounded directory tree with depth, file, hidden-file, and ignore controls. Use it for repository orientation without reading every file.',
    permission: 'auto',
    mutating: false,
    category: 'Files & search',
  },
  {
    name: 'lint',
    summary:
      'Run the project’s configured linter for a target path or working directory and return diagnostics. Use it after code edits to catch style and static-analysis issues.',
    permission: 'confirm',
    mutating: true,
    category: 'Quality & language',
  },
  {
    name: 'format',
    summary:
      'Run the project’s configured formatter on selected files or directories. Use it after editing code, while reviewing the resulting diff for unintended formatting scope.',
    permission: 'confirm',
    mutating: true,
    category: 'Quality & language',
  },
  {
    name: 'typecheck',
    summary:
      'Run TypeScript type checking for an auto-detected or specified tsconfig. Use it after type-affecting changes; it reports diagnostics without writing source files.',
    permission: 'confirm',
    mutating: false,
    category: 'Quality & language',
  },
  {
    name: 'test',
    summary:
      'Run the detected test runner for selected tests, with optional name filtering, coverage, watch, and timeout controls. Prefer focused tests first, then broader validation as needed.',
    permission: 'confirm',
    mutating: false,
    category: 'Quality & language',
  },
  {
    name: 'language_info',
    summary:
      'Inspect detected language tooling, workspaces, and supported operations for the project or target path. Use it before invoking language-specific tooling.',
    permission: 'auto',
    mutating: false,
    category: 'Quality & language',
  },
  {
    name: 'language',
    summary:
      'Run a supported language-tooling operation in a detected workspace. Use it when the language profile provides a safer, structured alternative to an arbitrary shell command.',
    permission: 'confirm',
    mutating: true,
    category: 'Quality & language',
  },
  {
    name: 'language_package',
    summary:
      'Plan or perform a dependency operation through the detected package ecosystem. Use dry-run first when possible and specify the workspace or dependency scope deliberately.',
    permission: 'confirm',
    mutating: true,
    category: 'Quality & language',
  },
  {
    name: 'install',
    summary:
      'Install project dependencies with the detected package manager. Use only when dependency changes are required, and inspect lockfile and manifest changes afterward.',
    permission: 'confirm',
    mutating: true,
    category: 'Dependencies & operations',
  },
  {
    name: 'audit',
    summary:
      'Run the package manager’s dependency vulnerability audit and summarize actionable findings. Use it to assess known dependency advisories, not source-code vulnerabilities.',
    permission: 'confirm',
    mutating: false,
    category: 'Dependencies & operations',
  },
  {
    name: 'outdated',
    summary:
      'List outdated project dependencies and available versions without changing manifests or lockfiles. Use it to plan dependency maintenance.',
    permission: 'confirm',
    mutating: true,
    category: 'Dependencies & operations',
  },
  {
    name: 'logs',
    summary:
      'Read or tail configured local, container, or process logs with bounded output. Use it to investigate a known runtime failure or service behavior.',
    permission: 'confirm',
    mutating: false,
    category: 'Dependencies & operations',
  },
  {
    name: 'design',
    summary:
      'Choose, preview, or materialize a UI design kit (e.g. minimal-clarity, neo-brutalist) for the active stack. Lists available kits, previews tokens, or writes a design-token source file to the project.',
    permission: 'confirm',
    mutating: true,
    category: 'Generation & design',
  },
  {
    name: 'tool_search',
    summary:
      'Search the full tool catalog by name or description, including tools whose schemas were withheld from this request to save tokens. Results include each matching tool input schema; use it before concluding a capability is unavailable, then invoke the local tool with tool_use instead of searching MCP.',
    permission: 'auto',
    mutating: false,
    category: 'Discovery & index',
  },
  {
    name: 'clarify',
    summary:
      'Record or ask a focused clarification when a missing decision would materially change the implementation. Do not use it for questions that can be answered from the repository.',
    permission: 'auto',
    mutating: false,
    category: 'Work & state',
  },
  {
    name: 'tool_use',
    summary:
      'Invoke a registered tool by its exact name, including one not listed in this request. Use it for a tool found through tool_search; the call still goes through the same permission and capability checks as a direct call.',
    permission: 'confirm',
    mutating: true,
    category: 'Discovery & index',
  },
  {
    name: 'codebase-index',
    summary:
      'Build or refresh the local semantic codebase index, optionally for selected languages. Use it when index results are absent or stale; force performs a full reindex.',
    permission: 'confirm',
    mutating: true,
    category: 'Discovery & index',
  },
  {
    name: 'codebase-search',
    summary:
      'Search indexed symbols, signatures, and documentation with optional language, kind, path, or LSP-kind filters. Use it for semantic discovery before broad text search.',
    permission: 'auto',
    mutating: false,
    category: 'Discovery & index',
  },
  {
    name: 'codebase-skeleton',
    summary:
      'Extract a compact structural skeleton from a source file or directory, preserving declarations while omitting implementation detail. Use it to understand unfamiliar code quickly.',
    permission: 'auto',
    mutating: false,
    category: 'Discovery & index',
  },
  {
    name: 'codebase-repo-map',
    summary:
      'Generate a centrality-ranked, token-budgeted Repository Map within ~1200 tokens by default: package clusters with their hub file, the repo-wide hotspots, then the signatures of the most central files. Use at the beginning of complex tasks or when navigating unfamiliar repositories to get a bird-eye view of the architecture.',
    permission: 'auto',
    mutating: false,
    category: 'Discovery & index',
  },
  {
    name: 'codebase-context',
    summary:
      'Find the files and declarations a task touches from a plain-language description. Ranked symbol search seeds a personalised walk over the reference graph, so results include what the matches are structurally attached to, not just what matched by name. Start here for any task spanning more than one file.',
    permission: 'auto',
    mutating: false,
    category: 'Discovery & index',
  },
  {
    name: 'codebase-read-symbol',
    summary:
      'Read the exact implementation of a named declaration (function, method, class, interface, type, enum, variable) from a file using AST parsing. Returns line-numbered code in standard N→content format, eliminating offset guessing and saving context tokens.',
    permission: 'auto',
    mutating: false,
    category: 'Discovery & index',
  },
  {
    name: 'codebase-ast-replace',
    summary:
      'Replace a named declaration using source-aware structure instead of fragile text matching. Use it for a function, method, class, interface, or variable when the target is unambiguous.',
    permission: 'confirm',
    mutating: true,
    category: 'Discovery & index',
  },
  {
    name: 'codebase-invariant-check',
    summary:
      'Compare candidate code with its original source and report structural invariants that may have changed. Use before writing a risky refactor; it validates but does not modify files.',
    permission: 'auto',
    mutating: false,
    category: 'Discovery & index',
  },
  {
    name: 'codebase-impact-analysis',
    summary:
      'Find likely callers, dependents, related tests, and change risk for a named symbol. Use it before changing a public or widely used declaration.',
    permission: 'auto',
    mutating: false,
    category: 'Discovery & index',
  },
  {
    name: 'codebase-targeted-test',
    summary:
      'Discover and run tests that cover a specified symbol, source file, or explicit test files. Use it for focused regression validation after a change.',
    permission: 'confirm',
    mutating: false,
    category: 'Quality & language',
  },
  {
    name: 'security-ast-scan',
    summary:
      'Statically scan source code for supported security patterns and return findings with locations. Use it as a focused code check, not as a substitute for a full security assessment.',
    permission: 'auto',
    mutating: false,
    category: 'Quality & language',
  },
  {
    name: 'codebase-incoming-calls',
    summary:
      'Find indexed call sites that invoke a named function, method, or type, optionally scoped to a file. Use it to estimate breakage before changing an API.',
    permission: 'auto',
    mutating: false,
    category: 'Discovery & index',
  },
  {
    name: 'codebase-outgoing-calls',
    summary:
      'Find indexed symbols called by a named function, method, or type, optionally scoped to a file. Use it to understand dependencies before refactoring behavior.',
    permission: 'auto',
    mutating: false,
    category: 'Discovery & index',
  },
  {
    name: 'codebase-stats',
    summary:
      'Report codebase-index health, indexed file and symbol counts, languages, and freshness. Use it before relying on indexed discovery results.',
    permission: 'auto',
    mutating: false,
    category: 'Discovery & index',
  },
  {
    name: 'dead-code-scan',
    summary:
      'Find dead code in executable TS/JS sources: unreachable files, exports nothing imports, unused re-exports, test-only code and unused dependencies. Read-only; pass previewIds to see the exact cleanup diff.',
    permission: 'auto',
    mutating: false,
    category: 'Discovery & index',
  },
  {
    name: 'present_artifact',
    summary:
      'Present an existing project text file, raster image, unified diff, or an owned live browser session. Graphical surfaces use read-only previews or their file viewer. The request is scoped to the current session and does not change contents.',
    permission: 'auto',
    mutating: false,
    category: 'Work & state',
  },
  {
    name: 'dead-code-fix',
    summary:
      'Remove dead code by dead-code-scan finding id: re-scans, applies, typechecks, rolls back on failure and keeps an undo backup. Only for ids the user chose after reviewing the scan.',
    permission: 'confirm',
    mutating: true,
    category: 'Discovery & index',
  },
  {
    name: 'codebase-read-symbol',
    summary:
      'Read the exact implementation of a named declaration (function, method, class, interface, type, enum, variable) from a file using AST parsing. Returns line-numbered code in standard N→content format, eliminating offset guessing and saving context tokens.',
    permission: 'auto',
    mutating: false,
    category: 'Discovery & index',
  },
] as const;

export const pluginSources = ['Core', 'Suite', 'Bridge'] as const;

export const pluginCatalog = [
  {
    name: 'wstack-prompts',
    risk: 'medium',
    summary: 'Prompt library and prompt authoring commands.',
    defaultState: 'active',
    source: 'Core',
  },
  {
    name: 'wstack-sync',
    risk: 'medium',
    summary: 'Cloud sync commands for prompts, skills, settings, memory, and history.',
    defaultState: 'active',
    source: 'Core',
  },
  {
    name: 'wstack-cloud-config-sync',
    risk: 'medium',
    summary: 'my.wrongstack.com config synchronization over the namespaced sync API.',
    defaultState: 'active',
    source: 'Core',
  },
  {
    name: 'wstack-chimera',
    risk: 'medium',
    summary: 'Spawns a post-session code review subagent, on by default.',
    defaultState: 'active',
    source: 'Core',
  },
  {
    name: 'wstack-auto-review',
    risk: 'medium',
    summary: 'Tracks changed files and requests bounded mid-session Chimera reviews.',
    defaultState: 'active',
    source: 'Core',
  },
  {
    name: 'wstack-specialist-triggers',
    risk: 'medium',
    summary: 'Spawns roster specialists when files matching their patterns change.',
    defaultState: 'inactive',
    source: 'Core',
  },
  {
    name: 'wstack-skills',
    risk: 'medium',
    summary: 'Skill library, authoring, install, update, and uninstall commands.',
    defaultState: 'active',
    source: 'Core',
  },
  {
    name: '@wrongstack/plug-lsp',
    risk: 'medium',
    summary: 'Language Server Protocol tools and slash commands.',
    defaultState: 'inactive',
    source: 'Core',
  },
  {
    name: 'telegram',
    risk: 'medium',
    summary: 'Telegram bridge for messages, approvals, and notifications.',
    defaultState: 'inactive',
    source: 'Bridge',
  },
  {
    name: 'agent-handoff',
    risk: 'medium',
    summary:
      'Listens for subagent.done events and posts structured handoff notes to the project mailbox',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'cost-tracker',
    risk: 'low',
    summary: 'Tracks LLM token usage and estimated cost per session with per-model breakdown',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'file-watcher',
    risk: 'medium',
    summary: 'Watches project files and emits events when changes occur (add, change, delete)',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'git-autocommit',
    risk: 'high',
    summary: 'AI-powered git staging and conventional commit message generation',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'auto-doc',
    risk: 'medium',
    summary: 'Auto-generates JSDoc/TSDoc comments for functions, classes, types, and interfaces',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'shell-check',
    risk: 'low',
    summary:
      'Runs shellcheck analysis on bash/shell scripts and surfaces issues with severity levels',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'cron',
    risk: 'medium',
    summary: 'Schedules recurring tasks using beforeIteration/afterIteration extension hooks',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'template-engine',
    risk: 'medium',
    summary: 'Expands file templates with variable substitution, conditionals, and loops',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'semver-bump',
    risk: 'high',
    summary: 'Conventional-commit-driven semver version bumps with changelog generation',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'secret-scanner',
    risk: 'high',
    summary:
      'Pre-tool hook that blocks (or optionally redacts) tools whose arguments contain plaintext credentials',
    defaultState: 'active',
    source: 'Suite',
  },
  {
    name: 'token-budget',
    risk: 'medium',
    summary:
      'Enforces a per-session token budget — warns at a threshold and stops the agent loop when the limit is hit',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'lint-gate',
    risk: 'medium',
    summary:
      'Pre-tool hook that runs biome/eslint on would-be file content before write or edit commits',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'branch-guard',
    risk: 'high',
    summary:
      'Pre-tool hook that blocks commits, pushes, and merges to protected branches (default: main, master)',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'diff-summary',
    risk: 'low',
    summary:
      'PostToolUse hook that injects a compact git diff into the LLM context after every write or edit',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'commit-validator',
    risk: 'medium',
    summary:
      'PreToolUse hook that validates conventional-commit format before git_autocommit or bash git commit runs',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'format-on-save',
    risk: 'medium',
    summary:
      'PostToolUse hook that runs biome format --write on the file after every write or edit',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'test-runner-gate',
    risk: 'medium',
    summary:
      'PostToolUse hook that runs the relevant test file after every write or edit to a source file',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'import-organizer',
    risk: 'medium',
    summary:
      'PostToolUse hook that re-sorts and de-duplicates imports in a file after every write or edit',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'todo-listener',
    risk: 'low',
    summary:
      'PostToolUse hook on `todo` tool — broadcasts a status update to the project mailbox so other agents can see what this one is working on',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'session-recap',
    risk: 'low',
    summary:
      'Stop hook that posts a one-page session summary (tokens, tools, commits, last activity) to the project mailbox',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'spec-linker',
    risk: 'low',
    summary:
      'Markdown link auditor for plugin references. PostToolUse surfaces unlinked references; PreToolUse on `write` (autoFix) wraps them in markdown links via modifiedInput.',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'loop-breaker',
    risk: 'low',
    summary:
      'Detects runaway tool-call loops (identical repeats and A-B-A-B oscillation) — warns the model, then blocks',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'gitignore-guard',
    risk: 'low',
    summary:
      'PostToolUse hook that suggests or appends .gitignore entries for build-artifact-looking files after every write or edit',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'path-guard',
    risk: 'medium',
    summary:
      'Blocks or warns about writes, edits, and destructive shell commands touching protected paths (lockfiles, .env, .git, migrations)',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'process-guard',
    risk: 'high',
    summary:
      'Reports kill commands (taskkill, Stop-Process, kill, pkill, wmic) seen by bash/exec; the refusal itself is enforced by the built-in bash/exec kill guards.',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'context-pins',
    risk: 'low',
    summary:
      'Pin durable facts into the system prompt (pin_add/pin_remove/pin_list) — pins survive compaction and persist across sessions',
    defaultState: 'active',
    source: 'Suite',
  },
  {
    name: 'checkpoint',
    risk: 'medium',
    summary:
      'In-session file snapshots: auto-captures content before every write/edit and restores any pre-edit state on demand',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'error-lens',
    risk: 'low',
    summary:
      'Distills failed command output into a compact digest (error line + project stack frames) and flags repeated failures',
    defaultState: 'active',
    source: 'Suite',
  },
  {
    name: 'dep-guard',
    risk: 'medium',
    summary:
      'Supervises dependency installs: blocks deny-listed and just-published packages, flags typosquat lookalikes, unknown names and vulnerable versions',
    defaultState: 'active',
    source: 'Suite',
  },
  {
    name: 'config-validator',
    risk: 'low',
    summary:
      'Validates JSON/JSONC/YAML/TOML/.env files right after write/edit and reports syntax problems in the same turn',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'notify-hub',
    risk: 'medium',
    summary:
      'POSTs session events (stop, tool errors, budget thresholds) and ad-hoc notify_send messages to a configurable webhook',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'changelog-writer',
    risk: 'low',
    summary:
      'Collects session work (commits, edits, manual notes) and writes Keep-a-Changelog entries under [Unreleased] on demand',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'injection-shield',
    risk: 'low',
    summary:
      'Scans tool output (fetched pages, files) for prompt-injection patterns and warns the model that content is data, not instructions',
    defaultState: 'active',
    source: 'Suite',
  },
  {
    name: 'prompt-firewall',
    risk: 'high',
    summary:
      'Scans the provider wire for credential leaks before context reaches the LLM API (wrapProviderRunner); redact/warn/block. Opt-in; redact by default.',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'llm-cache',
    risk: 'medium',
    summary:
      'Caches identical provider requests and short-circuits the provider call on a hit (wrapProviderRunner). Opt-in; deterministic-only by default.',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'model-router',
    risk: 'medium',
    summary:
      'Routes each provider call to a different model by declarative size/tool rules (wrapProviderRunner). Opt-in; dry-run by default; routes within the active provider only.',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'pr-drafter',
    risk: 'low',
    summary:
      'Collects session work (commits, edited files, diff) and drafts a pull-request description',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'auto-escalate',
    risk: 'medium',
    summary:
      'On retryable provider errors, retries the turn with the next model in an escalation ladder (onError). Opt-in; defers to default recovery otherwise.',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'test-coverage-gate',
    risk: 'medium',
    summary: 'PostToolUse hook that detects test coverage regressions after source-file edits',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'type-gate',
    risk: 'medium',
    summary:
      'PostToolUse hook that runs TypeScript type-checking after every write or edit to a source file',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'token-throttle',
    risk: 'medium',
    summary:
      'Rolling-window tokens/min budget that delays provider calls to stay under a rate limit (wrapProviderRunner). Opt-in; delay capped by maxDelayMs.',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'plugin-stack-observer',
    risk: 'low',
    summary:
      'Observes the wrapProviderRunner stack and exposes it to operators (plugin_stack_status) and, optionally, to the LLM (system-prompt contributor).',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'dependency-vulnerability-gate',
    risk: 'high',
    summary:
      'PostToolUse hook that runs npm/pnpm audit after dependency installs and blocks or warns on vulnerabilities above a severity threshold',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'migration-planner',
    risk: 'low',
    summary:
      'Builds evidence-backed migration checklists with optional Council-reviewed risk analysis',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'auto-i18n-extractor',
    risk: 'low',
    summary:
      'Detects hardcoded user-facing strings in UI source files and suggests translation keys',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'doc-sync-guard',
    risk: 'low',
    summary:
      'PostToolUse hook that tracks changed public source files and warns when README/docs edits omit them',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'api-compatibility-gate',
    risk: 'medium',
    summary:
      'PostToolUse hook that detects breaking API changes (removed exports) in entry-point files after writes or edits',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'performance-regression-gate',
    risk: 'medium',
    summary:
      'Compares benchmark results to detect performance regressions and reports metrics that increased beyond the configured threshold',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'test-flake-detector',
    risk: 'medium',
    summary: 'Runs a test command multiple times and reports tests that fail non-deterministically',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'schema-evolution-guard',
    risk: 'high',
    summary:
      'PostToolUse hook that guards database/API schema changes by detecting destructive patterns in schema files',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'license-audit-gate',
    risk: 'high',
    summary:
      'PostToolUse hook that audits dependency licenses after package-manager install/add commands and blocks disallowed licenses',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'accessibility-auditor',
    risk: 'medium',
    summary:
      'Audits .tsx/.jsx/.html/.vue files for common accessibility issues and reports findings after writes/edits',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'security-hotspot-scanner',
    risk: 'high',
    summary:
      'Scans source code for security anti-patterns and warns after writes/edits that introduce new hotspots',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'duplicate-code-detector',
    risk: 'low',
    summary:
      'Finds duplicated code blocks across source files using normalized-line fingerprinting',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'test-generator',
    risk: 'low',
    summary:
      'Generates framework-correct test skeletons with optional host-routed LLM test authoring',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'release-notes-generator',
    risk: 'low',
    summary:
      'Generates traceable release notes from conventional commits with optional LLM polishing',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'workspace-health',
    risk: 'medium',
    summary:
      'Inspects supplied workspace configuration evidence for broken package-manager, Node, and script contracts',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'test-impact-analyzer',
    risk: 'medium',
    summary:
      'Inspects diffs and test output for untested changes, focused-test exclusions, and skipped coverage evidence',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'ci-failure-triage',
    risk: 'medium',
    summary:
      'Classifies supplied CI logs into actionable dependency, test, type-check, and infrastructure failure evidence',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'env-contract-guard',
    risk: 'medium',
    summary:
      'Inspects environment templates and runtime diagnostics for missing, placeholder, or accidentally exposed configuration contracts',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'dependency-drift-detector',
    risk: 'medium',
    summary:
      'Inspects manifests and package-manager output for unpinned ranges, lockfile mismatch, and peer dependency drift',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'release-readiness',
    risk: 'medium',
    summary:
      'Inspects supplied release-gate output for unmet validation, dirty-tree, publish, and version-alignment evidence',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'bundle-budget-guard',
    risk: 'medium',
    summary:
      'Inspects build and bundle reports for budget breaches, unexpectedly large assets, and sourcemap publication signals',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'public-api-auditor',
    risk: 'medium',
    summary:
      'Inspects public entry-point evidence for undocumented exports, deprecated contracts, and accidental internal API exposure',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'lockfile-consistency-guard',
    risk: 'medium',
    summary:
      'Inspects lockfile and install evidence for mixed package managers, integrity failures, and reproducibility breaks',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'change-risk-classifier',
    risk: 'medium',
    summary:
      'Inspects diffs or change descriptions for authentication, persistence, destructive-operation, and compatibility risk signals',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'bug-reproducer',
    risk: 'high',
    summary:
      'Runs a supplied regression command twice against fingerprinted files and distinguishes a reproducible failure from instability or infrastructure errors',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'verification-ledger',
    risk: 'high',
    summary:
      'Records executed checks with source fingerprints and invalidates their evidence when relevant files change within the host session',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'acceptance-verifier',
    risk: 'high',
    summary:
      'Executes explicit acceptance criteria and maps each requirement to a command result and source fingerprint, preserving missing and stale evidence',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'runtime-trace-explorer',
    risk: 'low',
    summary:
      'Reconstructs parent-child runtime spans from a local trace export and identifies broken ancestry, failed spans and missing expected layers',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'workspace-recipe-runner',
    risk: 'high',
    summary:
      'Discovers explicit package scripts and their package-manager and runtime prerequisites, then runs a selected structured command',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'architecture-boundary-checker',
    risk: 'low',
    summary:
      'Builds a literal source import graph, reports dependency cycles, and checks explicitly forbidden directory boundaries',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'monorepo-change-planner',
    risk: 'low',
    summary:
      'Computes transitive workspace consumers and dependency-first validation order from explicit package manifests and changed paths',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'config-migration-assistant',
    risk: 'low',
    summary:
      'Previews explicit JSON configuration key renames and defaults while preserving custom values and refusing destination conflicts',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'feature-flag-lifecycle',
    risk: 'low',
    summary:
      'Maps declared feature flags to literal source references and reports expired flags and definitions without visible consumers',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'generated-artifact-tracker',
    risk: 'low',
    summary:
      'Tracks source and generated-output fingerprints for declared generators and reports which artifacts need regeneration after changes',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'api-consumer-replay',
    risk: 'medium',
    summary:
      'Replays explicit consumer HTTP fixtures against a loopback API and compares status and selected JSON fields without following redirects',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'migration-rehearsal',
    risk: 'high',
    summary:
      'Rehearses SQLite up/down migrations in a fresh in-memory database and compares schema and data snapshots before and after rollback',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'failure-injection-lab',
    risk: 'high',
    summary:
      'Runs a caller-supplied recovery test against a temporary loopback endpoint injecting HTTP 429, malformed JSON, disconnects or delayed responses',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'concurrency-scenario-tester',
    risk: 'medium',
    summary:
      'Issues synchronized loopback HTTP requests and verifies an explicit allowed-success count plus an optional final-state JSON invariant',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'resource-lifecycle-inspector',
    risk: 'high',
    summary:
      'Runs a JavaScript lifecycle fixture repeatedly in a child process and compares observable active resource counts after each cleanup against its baseline',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'visual-regression-reviewer',
    risk: 'low',
    summary:
      'Compares decoded PNG screenshot pixels and reports changed-pixel ratios and a bounding rectangle with explicit tolerance',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'responsive-journey-tester',
    risk: 'high',
    summary:
      'Runs explicit Playwright browser journeys at selected viewport sizes and checks required controls for visibility, reachability and horizontal overflow',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'localization-completeness',
    risk: 'low',
    summary:
      'Compares nested JSON locale keys, empty translations and interpolation variables across languages, including explicitly keyed plural variants',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'executable-documentation',
    risk: 'high',
    summary:
      'Executes explicitly marked JavaScript documentation examples in Node and records their actual exit status and source location',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'dependency-upgrade-sandbox',
    risk: 'high',
    summary:
      'Copies selected fixture files to a temporary directory, changes one npm dependency, installs without lifecycle scripts and runs explicit validation commands',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'developer-environment-doctor',
    risk: 'high',
    summary:
      'Probes the active Node runtime, declared package-manager launcher and dependency-install presence using the project package manifest',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'service-topology-inspector',
    risk: 'medium',
    summary:
      'Probes declared loopback service health endpoints, maps dependency failures and reports missing services and topology cycles',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'decision-journal',
    risk: 'medium',
    summary:
      'Appends explicit architectural decisions and rationales to a project JSONL journal and retrieves decisions linked to changed files',
    defaultState: 'inactive',
    source: 'Suite',
  },
  {
    name: 'plugin-workbench',
    risk: 'high',
    summary:
      'Loads a built plugin in a bounded child-process harness and measures duplicate tool registration, hook cleanup and setup/teardown lifecycle behavior',
    defaultState: 'inactive',
    source: 'Suite',
  },
] as const;

/* =========================================================================
   Detail-page helpers — slugs and lookups for /plugins/:slug and /tools/:slug.
   ========================================================================= */

export type PluginCatalogEntry = (typeof pluginCatalog)[number];
export type ToolCatalogEntry = (typeof toolCatalog)[number];

export function pluginSlug(name: string): string {
  return name.replace(/^@/, '').replace(/\//g, '-');
}

export function pluginFromSlug(slug: string): PluginCatalogEntry | undefined {
  return pluginCatalog.find((plugin) => pluginSlug(plugin.name) === slug);
}

export function toolSlug(name: string): string {
  return name.replace(/_/g, '-');
}

export function toolFromSlug(slug: string): ToolCatalogEntry | undefined {
  return toolCatalog.find((tool) => toolSlug(tool.name) === slug);
}

/** Derived counts — always match the actual array lengths, never hardcode. */
export const TOOL_COUNT = toolCatalog.length;
export const PLUGIN_COUNT = pluginCatalog.length;

/**
 * Provider-facing tool count for each token-saving tier.
 *
 * Generated by `scripts/generate-website-tool-catalog.ts` from
 * `BUILTIN_TIER_COUNTS` (packages/tools/src/tool-tier.ts), which derives every
 * number from the TIER1/TIER2/TIER3 arrays. Never hand-edit these values: run
 * `pnpm website:tools:write` after any catalog or tier change. Hand-written
 * copies of these numbers drifted the `medium` tier (47 vs the real 48) when a
 * built-in moved tier without a page update.
 */
// generated:tool-tier-counts
export const TOOL_TIER_COUNTS = {
  off: 73,
  minimal: 29,
  light: 29,
  medium: 52,
  aggressive: 29,
} as const;
