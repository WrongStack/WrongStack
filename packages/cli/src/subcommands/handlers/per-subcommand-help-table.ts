import type { PerSubcommandHelp } from './per-subcommand-help-types.js';

export const helpTable: Record<string, PerSubcommandHelp> = {
  init: {
    name: 'init',
    title: 'wstack init — DEPRECATED (use wstack auth)',
    description:
      '⚠ This command is deprecated. Use wstack auth for setup, key management, ' +
      'and model selection in one interactive workflow.',
    usage: 'wstack init (deprecated)',
    seeAlso: 'wstack auth (interactive setup + key manager)',
  },
  version: {
    name: 'version',
    title: 'wstack version — print the CLI version',
    description:
      'Prints the WrongStack CLI version, the apiVersion, the Node.js ' +
      'version, and the host platform. Useful for bug reports and CI logs.',
    usage: 'wstack version',
  },
  mcp: {
    name: 'mcp',
    title: 'wstack mcp — manage Model Context Protocol servers',
    description:
      'List, add, remove, restart, and serve MCP servers registered in the ' +
      'global config. Servers are referenced by id and use the stdio, SSE, ' +
      'or streamable-HTTP transports.',
    usage: 'wstack mcp [list|add|remove|restart|serve] [...]',
    subcommands: [
      { name: 'list', description: 'List all configured MCP servers.' },
      { name: 'add <id> <command>', description: 'Register a new stdio MCP server.' },
      { name: 'remove <id>', description: 'Unregister an MCP server.' },
      { name: 'restart <id>', description: 'Restart a running MCP server.' },
      {
        name: 'serve',
        description:
          'Run the wstack MCP server; --resources/--prompts explicitly expose selected files.',
      },
    ],
    seeAlso: 'wstack plugin (manage tool plugins similarly)',
  },
  plugin: {
    name: 'plugin',
    title: 'wstack plugin — manage tool plugins',
    description:
      'List, inspect, install, add, remove, enable, disable, and toggle tool plugins. ' +
      'Plugins extend the agent with custom tool packs (e.g. GitHub, ' +
      'Playwright, project-local helpers).',
    usage:
      'wstack plugin [list|status|report|menu|official|add|install|toggle|remove|enable|disable|manager] [...]',
    subcommands: [
      { name: 'list', description: 'List installed plugins (alias: status).' },
      { name: 'report', description: 'Show effective state, risk, and lock/toggle policy.' },
      { name: 'menu', description: 'Print the audit report outside the TUI plugin picker.' },
      { name: 'official', description: 'List plugins from the official registry.' },
      { name: 'add <id>', description: 'Add a plugin by id (alias: install).' },
      { name: 'toggle <id>', description: 'Toggle a safe audit-list plugin row.' },
      { name: 'remove <id>', description: 'Remove an installed plugin (aliases: rm, uninstall).' },
      { name: 'enable <id>', description: 'Re-enable a previously-disabled plugin.' },
      { name: 'disable <id>', description: 'Temporarily disable a plugin without removing it.' },
      {
        name: 'manager [lock|unlock] <id|*>',
        description: 'Control whether the LLM may enable/disable individual plugins.',
      },
    ],
    seeAlso: 'wstack mcp (MCP servers are registered as tool plugins)',
  },
  models: {
    name: 'models',
    title: 'wstack models — list and override models',
    description:
      'List models from the models.dev catalog, or override the ' +
      'default model for a provider with a custom id (for self-hosted ' +
      'or fine-tuned models not in the public catalog).',
    usage: 'wstack models [<provider>] [add|remove|list|refresh] [...]',
    subcommands: [
      { name: '<no-subcommand>', description: 'List models for the default provider.' },
      { name: '<provider>', description: 'List models for a specific provider.' },
      {
        name: 'add <mid>',
        description: 'Add or override a custom model (--max-context, --tools, --vision, …).',
      },
      { name: 'remove <mid>', description: 'Remove a custom model.' },
      { name: 'list', description: 'List all custom models registered locally.' },
      { name: 'refresh', description: 'Force-refresh the models.dev cache.' },
    ],
    seeAlso: 'wstack providers (list provider families and their defaults)',
  },
  config: {
    name: 'config',
    title: 'wstack config — show or edit effective config',
    description:
      'Print the resolved config (with the on-disk overrides merged ' +
      'on top), or open the active profile config in $EDITOR for interactive ' +
      'edits. Also exposes a small audit log of recent config-history ' +
      'changes for diagnostics.',
    usage: 'wstack config [show|edit|history|restore] [...]',
    subcommands: [
      { name: 'show', description: 'Print the resolved config to stdout (default).' },
      { name: 'edit', description: 'Open the active profile config in $EDITOR.' },
      { name: 'history', description: 'List recent config-history entries.' },
      { name: 'restore <id>', description: 'Restore a previous config-history entry.' },
    ],
    seeAlso: 'wstack auth (most config edits are auth/key changes)',
  },
  // -- API key / auth management -----------------------------------------
  auth: {
    name: 'auth',
    title: 'wstack auth — manage API keys and provider credentials',
    description:
      'Add, view, and remove provider API keys. The interactive menu ' +
      'supports a custom-URL path for self-hosted / local servers, a ' +
      'quick-shortcut path for Ollama / vLLM / LM Studio, and a catalog ' +
      'path for the well-known providers.',
    usage:
      'wstack auth [list|status|remove] [...] | wstack auth <provider> | wstack auth local [...]',
    subcommands: [
      { name: 'list', description: 'List saved providers and key status.' },
      { name: 'status <id>', description: 'Show detail for one provider.' },
      { name: 'remove <id>', description: 'Remove a provider and its keys.' },
      { name: '<provider>', description: 'Add a key for a named provider (--label, --family, …).' },
      {
        name: 'local',
        description:
          'Pre-fill Ollama / vLLM / LM Studio (--name, --base-url, --no-probe, --model, --audit …).',
      },
      {
        name: 'login <chatgpt|claude|copilot>',
        description:
          'Subscription OAuth login: chatgpt (→ openai-codex), claude (→ anthropic-oauth), or copilot (→ github-copilot). Opens browser; no API key. ⚠ Using subscriptions outside official clients may violate provider ToS (account ban risk); an API key is the sanctioned path.',
      },
    ],
    seeAlso: 'wstack auth local (pre-fill Ollama / vLLM / LM Studio)',
  },

  // -- Session list / resume / show / fork --------------------------------
  sessions: {
    name: 'sessions',
    title: 'wstack sessions — list and resume recent sessions',
    description:
      'List recent sessions, show one session in detail, resume a ' +
      "session, or inspect a session's audit log. The audit log is " +
      "stored as JSONL next to each session's recording.",
    usage: 'wstack sessions [list|show|resume|fork|doctor|config|fleet] [...]',
    subcommands: [
      { name: 'list', description: 'List the most recent sessions.' },
      {
        name: 'doctor [--fix] [--json] [--limit N]',
        description:
          'Diagnose every journal in this project: unparsable lines, truncated ' +
          'tails, sessions that died mid-turn, missing or stale summary ' +
          'sidecars, and journals large enough to be slow to open. --fix ' +
          'rebuilds only derived artifacts (summary sidecars + the catalog ' +
          'index); journals are never edited.',
      },
      { name: 'show <id>', description: 'Show one session in detail.' },
      { name: 'resume [<id>]', description: 'Resume a session (latest if no id given).' },
      {
        name: 'fork [<id>] [--to N]',
        description: 'Create an isolated child journal at a persisted boundary.',
      },
      { name: 'config', description: 'Show or edit session-specific config.' },
      { name: 'fleet', description: 'List the active fleet of sessions.' },
    ],
    seeAlso: 'wstack audit (the session-level audit log reader)',
  },

  // -- Diagnostics --------------------------------------------------------
  doctor: {
    name: 'doctor',
    title: 'wstack doctor — health checks',
    description:
      'Run a series of health checks (provider + key + models cache ' +
      '+ secret vault + sessions dir + MCP server config) and exit ' +
      'non-zero if any check fails. Use as a CI gate or a post-install ' +
      'smoke test. With --daemons, inspect this project’s IPC daemons ' +
      'instead: each is reported live, stale, or stopped. A stale endpoint ' +
      'is one whose owner died without releasing it; daemons reclaim it on ' +
      'their next start, or --clear-stale removes it now. Listing never ' +
      'spawns a daemon.',
    usage: 'wstack doctor [--daemons [--clear-stale]]',
    seeAlso: 'wstack diag (read-only environment dump for bug reports)',
  },
  diag: {
    name: 'diag',
    title: 'wstack diag — read-only environment dump',
    description:
      'Print a key=value environment snapshot (apiVersion, cwd, project ' +
      'info, paths, cache age, configured provider + model, tool/plugin ' +
      'counts, MCP server count). Never modifies state — safe to paste ' +
      'into bug reports.',
    usage: 'wstack diag',
    seeAlso: 'wstack doctor (pass/fail health checks vs. this is a dump)',
  },

  // -- Session audit / replay / rewind -----------------------------------
  audit: {
    name: 'audit',
    title: "wstack audit — inspect a session's tamper-evident audit log",
    description:
      'Show the chained-hash entries for a recorded session and run ' +
      'a verification pass to surface any post-hoc modification. Each ' +
      'entry is SHA-256-chained to the previous; any tampering breaks ' +
      'the chain and is reported.',
    usage: 'wstack audit [<sessionId>] [--list]',
    subcommands: [
      { name: '<sessionId>', description: 'Show entries + verify chain (positional).' },
      { name: '--list / -l', description: 'List every session that has an audit log.' },
    ],
    seeAlso: 'wstack replay (the corresponding provider-response log)',
  },
  replay: {
    name: 'replay',
    title: "wstack replay — inspect a session's recorded provider responses",
    description:
      'Show the recorded request/response pairs for a session — the ' +
      'frozen inputs the agent saw, in order. This is the inspection ' +
      'surface; to actually re-run the agent with those responses, use ' +
      '`wstack --replay <sessionId>`.',
    usage: 'wstack replay [<sessionId>] [--list]',
    subcommands: [
      { name: '<sessionId>', description: 'Show the recorded entries (positional).' },
      { name: '--list / -l', description: 'List every session that has a replay log.' },
    ],
    seeAlso: 'wstack audit (the tamper-evident tool-call log)',
  },
  rewind: {
    name: 'rewind',
    title: 'wstack rewind — rewind a session to an earlier state',
    description:
      "Restore a session's in-memory state to a previous point in " +
      'its recording. The rewind is non-destructive: the original ' +
      'session is preserved, and a new resumed session picks up ' +
      'from the rewound point. Useful for re-running a fork of ' +
      'an exploration without losing the original.',
    usage: 'wstack rewind [<sessionId>] [--all|--last <n>|--to <id>] [--list] [--resume]',
    subcommands: [
      { name: '<sessionId>', description: 'Session id (positional; defaults to the latest).' },
      { name: '--all', description: 'Rewind to the start of the session.' },
      { name: '--last <n>', description: 'Rewind to `n` steps back from the end.' },
      { name: '--to <id>', description: 'Rewind to a specific step id.' },
      { name: '--list', description: 'List available rewind points for the session.' },
      { name: '--resume', description: 'Resume the rewound session after the rewind.' },
    ],
    seeAlso: 'wstack replay (the underlying provider-response log)',
  },

  // -- Export & usage ----------------------------------------------------
  export: {
    name: 'export',
    title: 'wstack export — render a session to a portable format',
    description:
      'Render a recorded session to Markdown, JSON, or plain text. ' +
      'Use Markdown for human-readable share/audit artifacts, JSON for ' +
      'downstream tooling, or text for grep-friendly search. Tools ' +
      'and diagnostics are included by default; toggle either off with ' +
      '`--no-tools` or `--no-diagnostics`.',
    usage:
      'wstack export <sessionId> [--format markdown|json|text] [--out <file>] [--no-tools] [--no-diagnostics]',
    subcommands: [
      { name: '<sessionId>', description: 'The session id to render (positional).' },
      {
        name: '--format <f> / -f <f>',
        description: 'Output format: markdown (default), json, or text.',
      },
      { name: '--out <file> / -o <file>', description: 'Write to <file> instead of stdout.' },
      { name: '--no-tools', description: 'Omit tool-call entries from the output.' },
      {
        name: '--no-diagnostics',
        description: 'Omit diagnostic entries (errors, retries) from the output.',
      },
    ],
    seeAlso: 'wstack replay (the recorded provider-response log)',
  },
  usage: {
    name: 'usage',
    title: 'wstack usage — token + cost summary',
    description:
      'Print a per-session token + cost summary from the audit log. ' +
      'Useful for cost reviews and the post-session billing recap. ' +
      'Aggregates input/output tokens and the per-model cost; ' +
      'requires the session to have been recorded with audit enabled.',
    usage: 'wstack usage',
    seeAlso: 'wstack export (full session render for archival)',
  },

  // -- Listing subcommands -----------------------------------------------
  providers: {
    name: 'providers',
    title: 'wstack providers — list providers from models.dev',
    description:
      'List provider families from the live models.dev catalog. ' +
      'Default view shows the popular three (Anthropic, OpenAI, ' +
      'Google); pass `--all` to include every supported family, ' +
      'or `--unsupported` to surface the ones without a built-in ' +
      'transport (which require a plugin).',
    usage: 'wstack providers [--all] [--unsupported]',
    subcommands: [
      { name: '--all', description: 'Include every supported family, not just the popular three.' },
      {
        name: '--unsupported',
        description: 'Include families without a built-in transport (need a plugin).',
      },
    ],
    seeAlso: 'wstack models (list models within a provider)',
  },
  tools: {
    name: 'tools',
    title: 'wstack tools — list registered tools',
    description:
      'List every tool the agent can invoke, with its owner ' +
      '(built-in / plugin) and permission level. Useful for auditing ' +
      'what a session can do, especially after installing a new plugin.',
    usage: 'wstack tools',
    seeAlso: 'wstack skills (list skills; tools + skills are the two extension surfaces)',
  },
  skills: {
    name: 'skills',
    title: 'wstack skills — list discovered skills',
    description:
      'List every skill the agent can invoke, grouped by source ' +
      '(bundled / user-installed / project-local). Skills are ' +
      'on-demand context packs that load only when triggered.',
    usage: 'wstack skills',
    seeAlso: 'wstack tools (tools are always-loaded; skills are on-demand)',
  },
  projects: {
    name: 'projects',
    title: 'wstack projects — list tracked projects',
    description:
      'List every project WrongStack has seen (tracked by a hashed ' +
      'root). Each entry shows the project root and the last-seen ' +
      'timestamp. Useful for cleaning up the global projects dir ' +
      'after a workspace migration.',
    usage: 'wstack projects',
  },

  // -- Lifecycle ---------------------------------------------------------
  update: {
    name: 'update',
    title: 'wstack update — self-update the CLI',
    description:
      'Check the latest npm version and update the globally-installed ' +
      '`wrongstack` package. Use `--check-only` to just print the ' +
      'current/latest without installing. Pass `--pm <manager>` (or its ' +
      'shorthand `--npm`, `--pnpm`, `--yarn`, `--bun`) to force a specific ' +
      'package manager; pass `--allow-scripts` (alias `--lifecycle-scripts`) ' +
      'to opt into package lifecycle scripts during the update (off by default). ' +
      'The update is global; run from any project root.',
    usage:
      'wstack update [--check-only] [--pm <manager>] [--allow-scripts (alias: --lifecycle-scripts)]',
    seeAlso: 'wstack version (read-only version info)',
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
    usage: 'wstack modeldiag [test|eval] [...]',
    subcommands: [
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
      'Run WrongStack against the Aider polyglot or SWE-bench ' +
      'Verified suites with deterministic graders. Used internally ' +
      'to compare model quality across releases; also useful for ' +
      'evaluating a new model before adopting it.',
    usage: 'wstack bench [run|report|list] [...]',
    subcommands: [
      { name: 'run', description: 'Run a benchmark suite (--suite <id> --models <config>).' },
      { name: 'report <dir>', description: 'Render the Markdown report for a prior run.' },
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
    title: 'wstack hq — start HQ command center or manage tokens',
    description:
      'Start the HQ server — a web dashboard for monitoring sessions, fleet ' +
      'status, and agent activity across projects — or manage browser and client authentication tokens.',
    usage:
      'wstack hq [serve] [--port <n>] [--password <secret>] [--tunnel] [--open] | wstack hq token [create|list|revoke]',
    subcommands: [
      { name: 'serve', description: 'Start the HQ dashboard server (default).' },
      {
        name: 'token create [label]',
        description: 'Mint a browser or client authentication token.',
      },
      { name: 'token list', description: 'List active HQ authentication tokens.' },
      { name: 'token revoke <id>', description: 'Revoke an issued HQ authentication token.' },
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
    title: 'wstack permissions — explain tool permission decisions',
    description:
      'Side-effect-free permission decision explainer. Evaluates the effective ' +
      'permission rules for a tool and input arguments without prompting, ' +
      'modifying trust files, or mutating state.',
    usage: "wstack permissions explain <tool> [--input '<json>'] [--json]",
    subcommands: [
      {
        name: 'explain <tool>',
        description: 'Explain how the permission policy evaluates a tool call.',
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

/**
 * Focused help for *deep* subcommands — `wstack <top> <deep> --help`.
 *
 * Each entry is keyed by `"<top>:<deep>"` (e.g. `"mcp:add"`,
 * `"models:remove"`). The handler for the top-level subcommand
 * (`mcpCmd`, `modelsCmd`, etc.) does a one-line lookup before its
 * top-level help short-circuit:
 *
 *   ```ts
 *   if (args.includes('--help') || args.includes('-h')) {
 *     if (args[0] && args[1] && renderDeepHelp(`${args[0]}:${args[1]}`, deps.renderer)) {
 *       return 0;
 *     }
 *     if (renderFocusedHelp('mcp', deps.renderer)) return 0;
 *   }
 *   ```
 *
 * Why a separate table from `helpTable`:
 *   - The two tables have different lookup keys (single string vs.
 *     `<top>:<deep>`) and would otherwise need a polymorphic
 *     discriminator on every read.
 *   - Deep subcommand help is a *level below* the top-level help;
 *     the top-level entry still points at the deep subcommand via
 *     the `Subcommands` table, and the deep entry is the detail
 *     page the user gets when they ask for help on the deep one.
 *   - A future contributor can add a deep help entry without
 *     touching the top-level entry — the two are independent.
 *
 * Only deep subcommands that have meaningful flags (beyond what
 * the top-level help already describes) get entries. Trivial
 * deep subcommands like `mcp list` or `config show` don't — the
 * top-level help already tells the user everything they need.
 */
