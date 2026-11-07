import type { PerSubcommandHelp } from './per-subcommand-help-types.js';

/**
 * Focused help for the lifecycle, integration and operations subcommands
 * (update, remote, acp, bench, hq, mailbox, permissions, project, sage,
 * chronicle, …) — spread into `helpTable` after the core commands.
 */
export const OPERATIONS_HELP_ENTRIES: Record<string, PerSubcommandHelp> = {
  // -- Lifecycle ---------------------------------------------------------
  update: {
    name: 'update',
    title: 'wstack update — self-update the CLI',
    description:
      'Update using the latest GitHub Releases binary. Legacy package installations ' +
      'print a warning, install the binary, then uninstall old global wrongstack / ' +
      '@wrongstack/cli packages from npm, pnpm, yarn and Bun. Package-manager updates ' +
      'are disabled; legacy manager/script flags are ignored with a warning. ' +
      'Use --check-only to report versions without installing or uninstalling anything.',
    usage: 'wstack update [--check-only]',
    seeAlso: 'wstack version (read-only version info)',
  },

  desktop: {
    name: 'desktop',
    title: 'wstack desktop — open, install and update WrongStack Desktop',
    description:
      'Opens the installed WrongStack Desktop (or the portable build of this repository ' +
      'checkout) and returns. The application runs only with its engine beside it, so a ' +
      'copy whose engine is missing is refused. install and update download the installer ' +
      "for this CLI's release (or --version <x>), verify it against DESKTOP-SHA256SUMS, and " +
      'run it on Windows, open the disk image on macOS, or print the sudo apt/dnf command on ' +
      'Linux. WRONGSTACK_DESKTOP_APP selects a specific copy.',
    usage: 'wstack desktop [install | update | path] [--version <x>] [--silent]',
    subcommands: [
      { name: '(none)', description: 'Open WrongStack Desktop.' },
      { name: 'install', description: 'Download, verify and install the release installer.' },
      {
        name: 'update',
        description: 'Install when the installed copy is older than the release.',
      },
      { name: 'path', description: 'Print the application and engine paths.' },
    ],
    seeAlso: 'wstack update (updates the CLI itself)',
  },

  remote: {
    name: 'remote',
    title: 'wstack remote — run WrongStack on another machine over SSH',
    description:
      'Runs WrongStack on the remote machine, in the given project directory, and ' +
      'opens its WebUI here through an SSH tunnel; the agent, its tools and its ' +
      'daemons run remotely. The system ssh is used, so ~/.ssh/config, your agent ' +
      'and known_hosts apply. The matching build is uploaded once per version to ' +
      '~/.wrongstack/remote and checked by SHA-256. A dropped connection is ' +
      'reopened; the remote host keeps running meanwhile. Nothing from your local ' +
      'configuration is copied: set up a provider in the remote WebUI the first time.',
    usage:
      'wstack remote <user@host:/path | ssh://user@host:port/path> [--port <n>] [--open] [--keep] [--ssh-config <file>] [--remote-binary <file>]',
    seeAlso: 'wstack --remote <target> (same command)',
  },

  // -- ACP (Agent Client Protocol) --------------------------------------
  acp: {
    name: 'acp',
    title: 'wstack acp — Agent Client Protocol (ACP) integration',
    description:
      'Run WrongStack as an ACP server (stdio) for editor clients (Zed, JetBrains, ' +
      'VS Code ACP), or orchestrate external ACP agents through spawn, probe, bench, ' +
      'and parallel fan-out.',
    usage: 'wstack acp [server|list|sync|spawn|parallel|probe|bench] [...]',
    subcommands: [
      { name: 'server / serve', description: 'Start WrongStack as an ACP stdio server (default).' },
      { name: 'list', description: 'List available ACP agents from the cache.' },
      { name: 'sync', description: 'Sync the official ACP agent registry into local cache.' },
      { name: 'spawn <id> <task>', description: 'Spawn an ACP agent and wait for results.' },
      {
        name: 'parallel <csv> <task>',
        description: 'Fan a task out to multiple ACP agents in parallel.',
      },
      { name: 'probe [csv]', description: 'Handshake-test installed ACP agents.' },
      { name: 'bench [csv] [--fs]', description: 'End-to-end benchmark and grade ACP agents.' },
    ],
    seeAlso: 'wstack mcp serve (the MCP equivalent; pick the protocol your client speaks)',
  },

  // -- Model diagnostics (read-only) -----------------------------------
  modeldiag: {
    name: 'modeldiag',
    title: 'wstack modeldiag — model benchmarks + heuristic diagnostics',
    description:
      'Read-only diagnostics for the configured model: key check, ' +
      'capability scan (vision / tools / context window), heuristic ' +
      'strengths/weaknesses (bestFor / avoidFor), sequential live ' +
      'provider/model smoke tests, and real benchmarks against a small ' +
      'prompt suite. Smoke tests use tiny prompts and never print credentials.',
    usage: 'wstack modeldiag [preflight|test|eval] [...]',
    subcommands: [
      {
        name: 'preflight [provider-profile]',
        description:
          'Check native cloud provider setup without model requests or exposing credential values.',
      },
      {
        name: '<no subcommand>',
        description: 'Print configured model capabilities, context limits, and recommendations.',
      },
      {
        name: 'test [--plan|--all-models|--json]',
        description: 'Run live sequential smoke tests across configured models.',
      },
      {
        name: 'eval [--providers <csv>]',
        description: 'Run model competency matrix evaluation across tasks.',
      },
    ],
    seeAlso:
      'wstack modeldiag test --plan; wstack modeldiag test; wstack modeldiag test --all-models',
  },

  // -- Bench (developer / CI only) -------------------------------------
  bench: {
    name: 'bench',
    title: 'wstack bench — run model-independent agentic benchmarks',
    description:
      'Run WrongStack against the bundled smoke suite, a local manifest, ' +
      'Aider polyglot, or SWE-bench Verified with deterministic graders. ' +
      'Default `bench run` is the bundled core edit-eval; pass --cell provider/model (or a saved model).',
    usage: 'wstack bench [run|compare|report|list|mine|review|route|experiment] [...]',
    subcommands: [
      { name: 'run', description: 'Run a suite. Default: bundled smoke + --cell or saved model.' },
      {
        name: 'compare <a> <b>',
        description: 'Diff two finished run directories (fingerprint-aware).',
      },
      { name: 'report <dir>', description: 'Render the Markdown report for a prior run.' },
      {
        name: 'review --transcript <file>',
        description: 'Read-only transcript behavior/compaction evidence; optional --policy.',
      },
      {
        name: 'route <dir> --policy <file>',
        description: 'Shadow routing recommendations from graded model-matrix evidence.',
      },
      {
        name: 'experiment <a> <b> --dimension compaction|behavior',
        description: 'Compare paired task/model/attempt runs with explicit experiment provenance.',
      },
      { name: 'list', description: 'List available suites and the model configs in the catalog.' },
    ],
    seeAlso: 'wstack modeldiag (read-only diagnostics; bench actually runs the model)',
  },

  // -- Quick launch ------------------------------------------------------
  quick: {
    name: 'quick',
    title: 'wstack quick — launch the TUI with sensible defaults',
    description:
      'Accept every default, list installed plugins, and open the TUI ' +
      'with the agents-monitor panel pre-shown. Equivalent to ' +
      '`wstack --tui --quick`; the dedicated subcommand is for ' +
      'discoverability and tab-completion. The actual TUI launch is ' +
      'intercepted in `boot()` before this handler runs.',
    usage: 'wstack quick',
    seeAlso: 'wstack --tui (the underlying flag; quick is just a shortcut)',
  },
  // -- Aliases and meta commands ───────────────────────────────────────
  plugins: {
    name: 'plugins',
    title: 'wstack plugins — alias for wstack plugin',
    description:
      'Alias for `wstack plugin`. See `wstack plugin --help` for the full set of subcommands.',
    usage: 'wstack plugins (alias for wstack plugin)',
    seeAlso: 'wstack plugin (the canonical command)',
  },
  help: {
    name: 'help',
    title: 'wstack help — print top-level help',
    description:
      'Print the top-level help text listing every subcommand with a one-line ' +
      'summary. Equivalent to `wstack --help`.',
    usage: 'wstack help',
    seeAlso: 'wstack --help',
  },
  // -- HQ (dashboard server) ──────────────────────────────────────────
  hq: {
    name: 'hq',
    title: 'wstack hq — serve HQ, manage authentication, or install its system service',
    description:
      'Start the HQ server — a web dashboard for monitoring sessions, fleet ' +
      'status, and agent activity across projects; manage browser/client authentication, or install the persistent Ubuntu systemd service.',
    usage:
      'wstack hq [serve] [...] | wstack hq token [create|list|revoke] | wstack hq service [install|status|update|uninstall]',
    subcommands: [
      { name: 'serve', description: 'Start the HQ dashboard server (default).' },
      {
        name: 'token create [label]',
        description: 'Mint a browser or client authentication token.',
      },
      { name: 'token list', description: 'List active HQ authentication tokens.' },
      { name: 'token revoke <id>', description: 'Revoke an issued HQ authentication token.' },
      {
        name: 'service install',
        description: 'Install an always-on systemd service and guarded automatic updater.',
      },
      { name: 'service status', description: 'Inspect the HQ service and update timer.' },
      { name: 'service update', description: 'Run the guarded update job immediately.' },
      {
        name: 'service uninstall',
        description: 'Remove systemd units while preserving HQ data and secrets.',
      },
    ],
    seeAlso: 'wstack sessions fleet (CLI equivalent for fleet status)',
  },
  // -- Mailbox (external agent bridge) ────────────────────────────────
  mailbox: {
    name: 'mailbox',
    title: 'wstack mailbox — serve the external-agent mailbox HTTP bridge',
    description:
      'Start the mailbox HTTP bridge that lets external coding agents ' +
      '(Claude Code, Aider, custom scripts) communicate with the shared ' +
      'project mailbox. The server exposes a REST + SSE API for ' +
      'sending, checking, and acknowledging messages. Use `wstack mailbox serve` ' +
      'to start the listener.',
    usage: 'wstack mailbox serve [--port <n>]',
    subcommands: [{ name: 'serve', description: 'Start the mailbox HTTP bridge listener.' }],
    seeAlso: 'wstack hq (the HQ server includes mailbox routing)',
  },
  // -- Permissions ────────────────────────────────────────────────────
  permissions: {
    name: 'permissions',
    title: 'wstack permissions — list and explain the permission rules',
    description:
      'Side-effect-free views of the permission policy the agent runs under: ' +
      'every rule in the order it is checked, and how one tool call is decided, ' +
      'without prompting, modifying trust files, or mutating state. Inside a ' +
      'session, /permissions also sets allow/deny rules for that session only.',
    usage: "wstack permissions [rules|explain <tool> [--input '<json>']] [--json]",
    subcommands: [
      {
        name: 'rules',
        description:
          'List every permission rule, in the order they are checked (first match decides).',
      },
      {
        name: 'explain <tool>',
        description: 'Explain how the permission policy decides a tool call, and name the rule.',
      },
    ],
    seeAlso: 'wstack tools (list available tools)',
  },
  // -- Project management ─────────────────────────────────────────────
  project: {
    name: 'project',
    title: 'wstack project — manage committed repository identity',
    description:
      'Manage the committed repository identity (project.json) used to scope ' +
      'HQ dashboards, Kanban state, and multi-agent coordination. Commit the ' +
      'generated ID file so every clone shares the same project.',
    usage: 'wstack project [id|init|rekey] [--yes]',
    subcommands: [
      { name: 'id', description: 'Show the current project ID and config path (default).' },
      { name: 'init', description: 'Initialize a project ID if not already present.' },
      { name: 'rekey', description: 'Generate a new project ID for a fork (requires --yes).' },
    ],
    seeAlso: 'wstack projects (list all tracked projects)',
  },
  governance: {
    name: 'governance',
    title: 'wstack governance — inspect deterministic project-daemon health',
    description:
      'Read token-free attachment-broker health from the current project daemon. ' +
      'Warnings are advisory: they surface deterministic operator escalation signals ' +
      'without stopping active tasks or model execution.',
    usage: 'wstack governance status [--json]',
    subcommands: [{ name: 'status', description: 'Show daemon and attachment-broker health.' }],
    seeAlso: 'wstack doctor (broader environment diagnostics)',
  },
  'import-claude-code': {
    name: 'import-claude-code',
    title: 'wstack import-claude-code — bring a Claude Code setup across',
    description:
      'Import MCP servers from ~/.claude.json (user + this project) and the ' +
      "repository's .mcp.json into the active profile. Previews by default. " +
      'Repository servers arrive disabled unless --enable-project-servers. ' +
      'Skills are read in place; hooks, permission rules and CLAUDE.md are ' +
      'reported with next steps, not translated.',
    usage: 'wstack import-claude-code [--apply] [--overwrite] [--enable-project-servers]',
    subcommands: [
      { name: '--apply', description: 'Write the plan (default: preview only).' },
      { name: '--overwrite', description: 'Replace servers that already exist by name.' },
      {
        name: '--enable-project-servers',
        description: "Enable the repository's .mcp.json servers on import.",
      },
    ],
    seeAlso: 'wstack mcp list; --mcp-config (one-off servers without importing)',
  },
  sage: {
    name: 'sage',
    title: "wstack sage — this project's SAGE memory in other coding agents",
    description:
      'Wire SAGE memory into Claude Code, Codex, Cursor or Antigravity over MCP: ' +
      'writes the MCP server entry plus a skill/rule telling the agent when to recall ' +
      'and how to propose. The server attaches to the SAGE daemon while wstack is open ' +
      'in this project and never starts one. Tools are read-only plus memory_candidates ' +
      '(list/propose); a proposal becomes memory only through WrongStack review. ' +
      'Search is lexical: semantic recall runs inside a WrongStack host.',
    usage: 'wstack sage connect <claude-code|codex|cursor|antigravity|all|print> [--dry-run]',
    subcommands: [
      { name: 'connect <client|all>', description: 'Write the MCP entry and skill for a client.' },
      { name: 'connect print', description: 'Print JSON/TOML config for any other MCP client.' },
      { name: 'disconnect <client|all>', description: 'Remove what connect wrote.' },
      { name: 'mcp [--origin <name>]', description: 'The stdio MCP server clients run.' },
      {
        name: 'sync [--restart-service]',
        description:
          'Run project memory sync with HQ; optionally restart this project’s SAGE owner.',
      },
      { name: '--dry-run', description: 'Show the file changes without writing.' },
      { name: '--command <path>', description: 'Executable to launch instead of wstack.' },
    ],
    seeAlso: 'wstack mcp serve (all WrongStack tools over MCP)',
  },
  // -- Chronicle ──────────────────────────────────────────────────────
  chronicle: {
    name: 'chronicle',
    title: 'wstack chronicle — query cross-session provenance ledger',
    description:
      'Query the cross-session event ledger, inspect daemon status, compute ' +
      'facet aggregations, view token/cost metrics, or purge old retention entries.',
    usage: 'wstack chronicle [query|status|facet|metrics|prune|compact] [...]',
    subcommands: [
      { name: 'query [field=value ...]', description: 'Query recorded provenance events.' },
      { name: 'status', description: 'Check the Chronicle daemon and pipeline status.' },
      { name: 'facet <field>', description: 'Group and count events across a facet.' },
      {
        name: 'metrics [providers|tasks|files|summary]',
        description: 'Query aggregated metrics from metrics.db.',
      },
      {
        name: 'prune [--days N] [--dry-run]',
        description: 'Purge journal entries older than N days.',
      },
      { name: 'compact', description: 'Defragment and compact SQLite ledger.' },
    ],
    seeAlso: 'wstack audit (per-session audit log); wstack usage (cost summary)',
  },
};
