import type { CommandDetailMap } from './command-detail-types';

export const commandDetailsPart3: CommandDetailMap = {
  '/auth': {
    purpose: 'Open the API-key status dashboard — view, add, and verify provider authentication.',
    behavior:
      'The command displays all configured API keys (masked), their providers, last validation status, and expiration dates. You can add new keys, re-validate existing ones, and remove expired keys. Keys are stored encrypted with AES-256-GCM per machine.',
    before:
      'Have your API keys ready. Keys are never displayed in full — only the last 4 characters are shown.',
    during: 'The dashboard prints key status. Validation makes a test request to the provider API.',
    after: 'Remove unused or expired keys. Re-validate keys that show an unknown status.',
  },

  '/working_dir': {
    purpose:
      'Show or change the live working directory — control where the agent reads and writes files.',
    behavior:
      '`/working_dir` prints the current working directory. `/working_dir <path>` changes it. The new directory must be within the project root. All subsequent file operations (read, write, glob, grep) resolve relative to this directory. The change is session-scoped.',
    before: 'Verify the target directory exists and is within the project root.',
    during: 'The new path prints for confirmation. The change applies immediately.',
    after:
      'Run `/working_dir` again to confirm. Relative paths in subsequent commands will resolve from the new location.',
  },

  '/project': {
    purpose:
      'List, add, rename, remove, or switch registered projects — manage your WrongStack workspace.',
    behavior:
      'WrongStack tracks projects with metadata (name, root path, last opened). `/project` lists all registered projects. `/project add <path>` registers a new one. `/project switch <name>` changes the active project. `/project rename <old> <new>` relabels. `/project remove <name>` unregisters.',
    before: 'Run `/project` to see current projects before adding or switching.',
    during:
      'List shows all projects with the active one highlighted. Switch reloads the project context.',
    after:
      'Verify the active project with `/project`. Session state is per-project, so switching starts a fresh context.',
  },

  '/f': {
    purpose:
      'Open a numbered TUI function-key panel — access common operations through single-key shortcuts.',
    behavior:
      'The TUI function-key bar maps F1–F12 to frequent commands: F1=help, F2=context, F3=fleet, etc. `/f` opens the panel overlay showing all bindings. `/f <number>` triggers that binding directly. The panel is also accessible by pressing the function keys in the TUI.',
    before:
      'No preparation needed. Use it as a keyboard-driven alternative to typing slash commands.',
    during: 'The panel overlay shows labeled function keys. Press a key or type `/f <number>`.',
    after: 'The triggered command executes. The panel closes automatically.',
  },

  '/mouse': {
    purpose:
      'Capture mouse events for terminal UI testing — verify click, scroll, and hover behavior in the TUI.',
    behavior:
      'A developer-focused command that enables mouse event logging. Clicks, scrolls, and drags in the terminal are captured and printed with coordinates and event types. Useful for debugging TUI interaction bugs or verifying terminal emulator compatibility.',
    before: 'Ensure your terminal emulator supports mouse reporting.',
    during: 'Mouse events print to the console in real time with event type and coordinates.',
    after: 'Disable mouse capture when done testing to avoid console noise.',
  },

  '/design': {
    purpose:
      'Browse, pin, and materialize a curated Design Studio kit — apply a cohesive design system to UI work.',
    behavior:
      'WrongStack Design Studio offers 48+ curated design kits (neo-brutalist, minimal-clarity, cyberpunk-neon, etc.). `/design list` shows all kits. `/design use <kit-id>` loads and pins one. `/design materialize` writes CSS custom properties and Tailwind v4 @theme tokens to a file. `/design verify` scans UI files for off-palette colors.',
    before: 'Browse kits with `/design list`. Choose one that matches your project aesthetic.',
    during:
      'Using a kit pins it for the session. Materialize writes tokens to the configured output path.',
    after:
      'Verify your UI components use the design tokens with `/design verify`. Re-materialize after kit changes.',
  },

  '/codebase-reindex': {
    purpose:
      'Rebuild the project symbol and codebase search index — refresh the fast search database.',
    behavior:
      'The codebase index powers fast symbol search (`codebase-search` tool) and code understanding. `/codebase-reindex` rebuilds the SQLite+BM25 index from scratch. By default it processes only changed files; use `--force` for a full rebuild. Indexing runs in the background.',
    before:
      'Run when search results seem stale or after pulling new code. A full reindex can take minutes on large repos.',
    during: 'Progress prints: files indexed, symbols found, languages detected.',
    after:
      'Run `/codebase-reindex` again without `--force` to confirm the index is up to date. Search should now return current results.',
  },

  '/techstack': {
    purpose:
      'Scan dependencies, verify versions, and write a technology report — understand what your project depends on.',
    behavior:
      'The command scans package.json files, lockfiles, and config files across the project. It produces a report: runtime versions, dependency trees, outdated packages, security advisories, and compatibility notes. The report can be printed to the terminal or written to a file.',
    before: 'No preparation needed. Run it when onboarding to a project or before major upgrades.',
    during: 'The scan runs through workspace packages. A summary prints with categories.',
    after:
      'Address critical outdated packages. Run `/audit` for a deeper security review of dependencies.',
  },

  '/worktree': {
    purpose:
      'Inspect and manage git worktrees used by autonomous phases — isolate work without branch switching.',
    behavior:
      'Autonomous phase workflows create git worktrees for isolation. `/worktree list` shows all active worktrees. `/worktree add <path>` creates one manually. `/worktree remove <path>` cleans up. `/worktree prune` removes stale entries. Worktrees let multiple agents work on different branches simultaneously.',
    before:
      'Ensure the working tree is clean before creating worktrees. Stash or commit changes first.',
    during:
      'List shows worktree paths, branches, and status. Add creates a new worktree with a fresh checkout.',
    after:
      'Prune old worktrees to keep the workspace clean. Remove worktrees when their phase is complete.',
  },

  '/audit': {
    purpose:
      'Inspect the side-effect trail for shell, install, and fetch actions — see everything the agent has done.',
    behavior:
      'Every shell command, package install, and network fetch is logged with its full command, exit code, and output summary. `/audit` prints this trail chronologically. `/audit --since <time>` filters by recency. `/audit --tool <name>` filters by tool. Use it to verify the agent did not do anything unexpected.',
    before: 'No preparation needed. Run it after a long agent session to review its actions.',
    during: 'The trail prints with timestamps, commands, exit codes, and truncated output.',
    after: 'Investigate any unexpected commands. The audit trail is your accountability mechanism.',
  },

  '/security': {
    purpose:
      'Run dependency audit, scan dispatch, and redaction diagnostics — the security health check command.',
    behavior:
      '`/security audit-deps` runs a vulnerability scan on all dependencies. `/security scan` dispatches a security-scanner subagent to review code. `/security redact-test` verifies that secret redaction is working correctly. Results are categorized by severity with actionable fix recommendations.',
    before:
      'Run `/security audit-deps` regularly and before releases. The scan is read-only and safe.',
    during:
      'Audit results show vulnerability counts by severity. The scanner subagent reports findings in real time.',
    after:
      'Address critical and high-severity findings immediately. Re-run the audit after fixes to confirm resolution.',
  },

  '/commit': {
    purpose:
      'Stage changes and create a generated conventional commit — produce well-formed commit messages automatically.',
    behavior:
      'The command stages specified files (or auto-detects changed files), generates a conventional commit message (type, scope, summary, body) from the diff, and creates the commit. You can review the generated message before committing. Supports all conventional commit types: feat, fix, docs, refactor, test, chore, etc.',
    before: 'Review the diff with `/git diff` first. Know which files you want to commit.',
    during: 'The generated commit message appears for review. You can edit it before confirming.',
    after: 'Verify the commit with `/git log`. Push with `/push` when ready.',
  },

  '/git': {
    purpose:
      'Run high-level Git workflow actions through the command surface — status, log, diff, branch, checkout, stash, and more.',
    behavior:
      'The command wraps common git operations with safe defaults and structured output. `/git status` shows working tree state. `/git log` shows commit history. `/git diff` shows changes. `/git branch` manages branches. `/git checkout` switches. `/git stash` shelves changes. All operations are read-only by default unless explicitly mutating.',
    before: 'Check the working tree state with `/git status` before mutating operations.',
    during: 'Git output is formatted for readability. Errors include suggestions for resolution.',
    after: 'Verify the repository state after mutations. Use `/git log` to confirm commits.',
  },

  '/gitcheck': {
    purpose:
      'Silently inspect the working tree for uncommitted changes — a lightweight gate for automation.',
    behavior:
      'The command checks for uncommitted changes (modified, added, deleted, untracked files) and returns a clean/dirty status with a file count. It produces no output beyond the status unless changes are found. Ideal for pre-flight checks in automated workflows.',
    before: 'No preparation needed. Run it before operations that require a clean tree.',
    during: 'Returns instantly — no git operations beyond status check.',
    after: 'If dirty, review changes with `/git diff`. Commit or stash before proceeding.',
  },

  '/push': {
    purpose: 'Push the current branch to its configured remote — a safe wrapper around git push.',
    behavior:
      'The command pushes the current branch to its upstream remote. It checks for uncommitted changes first (warning, not blocking). It handles authentication through the configured git credential system. Output shows the push progress and the remote branch update.',
    before:
      'Commit your changes with `/commit`. Verify with `/git log` that the right commits are on the branch.',
    during: 'Push progress prints. Remote URL and branch name are shown.',
    after: 'Verify the push succeeded. Check the remote repository if needed.',
  },

  '/gitid': {
    purpose:
      'Inspect or manage Git identity used for repository operations — set name and email for commits.',
    behavior:
      '`/gitid` shows the current git user.name and user.email. `/gitid set name "..."` changes the name. `/gitid set email "..."` changes the email. Changes apply to the repository config by default; use `--global` for global config. The identity is used for commits created by `/commit`.',
    before: 'Verify your current identity with `/gitid` before making commits.',
    during: 'Identity changes print for confirmation.',
    after: 'Run `/gitid` again to confirm the change. The next commit will use the new identity.',
  },

  '/doctor': {
    purpose:
      'Diagnose and safely repair configuration problems with backup and history — fix broken setups.',
    behavior:
      'The command runs a series of diagnostic checks: Node.js version, package integrity, config file validity, provider connectivity, permission policy coherence, and plugin compatibility. It reports issues with severity levels and can auto-repair common problems (with backup). Each repair is logged.',
    before:
      'Run when something is not working as expected. The doctor is safe — it backs up before any change.',
    during: 'Diagnostics run sequentially. Issues are reported as they are found.',
    after:
      'Address any issues the doctor could not auto-repair. Review the repair log for changes made.',
  },

  '/tuneup': {
    purpose:
      'Audit session health, context cost, performance, and reliability settings — optimize your agent configuration.',
    behavior:
      'The command runs a comprehensive health audit: context efficiency, model choice appropriateness, permission policy strictness, plugin overhead, memory utilization, and fleet configuration. `/tuneup` prints recommendations. `/tuneup fix` applies safe optimizations. `/tuneup deep` runs extended diagnostics.',
    before: 'Run after several sessions or when you notice performance degradation.',
    during:
      'The audit runs multiple checks. Each recommendation includes a rationale and impact estimate.',
    after:
      'Apply recommended fixes with `/tuneup fix`. Review deep diagnostics for systemic issues.',
  },

  '/desktop': {
    purpose:
      'Explain how to access the local WrongStack Desktop application — the Electron-based GUI surface.',
    behavior:
      'The command prints instructions for launching and accessing the WrongStack Desktop application. It checks whether the desktop app is installed, shows the default port, and provides troubleshooting steps for common issues (port conflicts, white screen, connection refused).',
    before: 'Ensure WrongStack is installed. The desktop app may need to be launched separately.',
    during: 'Instructions print with platform-specific notes (Windows, macOS, Linux).',
    after: 'Open the desktop app URL in your browser or launch the Electron app directly.',
  },

  '/webui': {
    purpose:
      'Explain how to start and access the browser-based WrongStack interface — the WebUI surface.',
    behavior:
      'The command prints instructions for starting the WebUI server and accessing it in a browser. It shows the default bind address (loopback), how to change the port, and security considerations for remote access. The WebUI provides a graphical interface to the same agent kernel.',
    before: 'Ensure no other service is using the default WebUI port.',
    during: 'Instructions print with the server start command and the access URL.',
    after:
      'Start the WebUI server and open the URL. The WebUI connects to the same project mailbox as CLI agents.',
  },

  '/tool': {
    purpose:
      'Choose simple or extended tool-description detail — control how much tool metadata the agent sees.',
    behavior:
      'Tool descriptions consume context tokens. `/tool simple` uses minimal descriptions (name + one-liner). `/tool extended` uses full descriptions with parameter details. `/tool` shows the current setting. Simple mode saves tokens; extended mode gives the agent more precise tool understanding.',
    before: 'Consider your context budget. Extended mode adds ~20% to tool description tokens.',
    during: 'The change applies to the next agent turn. Current turn is unaffected.',
    after: 'Monitor tool use accuracy. If the agent misuses tools, switch to extended mode.',
  },

  '/tools': {
    purpose: 'List the complete registered tool inventory — see every tool the agent can use.',
    behavior:
      'The command prints all registered tools grouped by source (core, plugins, MCP). Each entry shows the tool name, description, permission level (auto/confirm/deny), and source. The list includes both built-in tools and those added by plugins and MCP servers.',
    before: 'No preparation needed. Run it to understand the agent capabilities.',
    during: 'The tool list prints in categorized sections. Long lists are paginated.',
    after:
      'Use `/tool` to adjust description detail. Disable unnecessary tools via plugin management or MCP control.',
  },

  '/plugin': {
    purpose:
      'List, inspect, enable, disable, and manage plugins — control WrongStack extensibility.',
    behavior:
      'Plugins add commands, tools, hooks, and skills. `/plugin list` shows all installed plugins with status. `/plugin enable <name>` activates one. `/plugin disable <name>` deactivates. `/plugin inspect <name>` shows what the plugin registers. Plugin state is persisted across sessions.',
    before:
      'Review what a plugin adds before enabling it. Some plugins register tools that consume context.',
    during: 'List shows plugin names, versions, status, and registration counts.',
    after: 'Disable unused plugins to reduce context overhead and startup time.',
  },
};
