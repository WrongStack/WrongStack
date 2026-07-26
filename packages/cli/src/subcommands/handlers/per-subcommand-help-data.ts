import { renderAuthLocalHelpToString } from './auth-local-help.js';
import { renderBenchRunHelpToString } from './bench-run-help.js';
import { renderModelsAddHelpToString } from './models-add-help.js';
import type { PerSubcommandHelp } from './per-subcommand-help.js';

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
    usage: 'wstack sessions [list|show|resume|fork|config|fleet] [...]',
    subcommands: [
      { name: 'list', description: 'List the most recent sessions.' },
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
      'smoke test.',
    usage: 'wstack doctor',
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
      'current/latest without installing. The update is global; run ' +
      'from any project root.',
    usage: 'wstack update [--check-only]',
    seeAlso: 'wstack version (read-only version info)',
  },

  // -- ACP (Agent Client Protocol) --------------------------------------
  acp: {
    name: 'acp',
    title: 'wstack acp — Agent Client Protocol (ACP) integration',
    description:
      'Run WrongStack as an ACP server (stdio) so it can be embedded ' +
      'in editor clients (Zed, JetBrains, VS Code ACP extension). ' +
      'The server blocks until stdin closes. Spawning a named ACP ' +
      'agent is reserved for a future release.',
    usage: 'wstack acp [serve]',
    seeAlso: 'wstack mcp serve (the MCP equivalent; pick the protocol your client speaks)',
  },

  // -- Model diagnostics (read-only) -----------------------------------
  modeldiag: {
    name: 'modeldiag',
    title: 'wstack modeldiag — model benchmarks + heuristic diagnostics',
    description:
      'Read-only diagnostics for the configured model: key check, ' +
      'capability scan (vision / tools / context window), heuristic ' +
      'strengths/weaknesses (bestFor / avoidFor), and (optionally) ' +
      'real benchmarks against a small prompt suite. Never modifies ' +
      'config — safe to run on any machine.',
    usage: 'wstack modeldiag',
    seeAlso: 'wstack doctor (pass/fail health checks)',
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
export const deepHelpTable: Record<string, PerSubcommandHelp> = {
  // -- mcp -----------------------------------------------------------------
  'mcp:add': {
    name: 'mcp:add',
    title: 'wstack mcp add <name> — register a built-in MCP server',
    description:
      'Register a built-in MCP server by alias (e.g. `github`, `playwright`) ' +
      'and write the entry to the global config. The server is added in ' +
      '`disabled` state by default; pass `--enable` to register it active ' +
      'immediately.',
    usage: 'wstack mcp add <name> [--enable]',
    subcommands: [
      {
        name: '<name>',
        description: 'The built-in server alias (run `wstack mcp add` for the list).',
      },
      {
        name: '--enable / -e',
        description: 'Register the server enabled (default: disabled until you opt in).',
      },
    ],
    seeAlso: 'wstack mcp list (verify the entry landed); wstack mcp remove',
  },
  'mcp:remove': {
    name: 'mcp:remove',
    title: 'wstack mcp remove <name> — unregister an MCP server',
    description:
      'Unregister an MCP server by alias. Removes the entry from the global ' +
      'config; the server process is not killed (REPL restart required to ' +
      'fully tear down the running process).',
    usage: 'wstack mcp remove <name>',
    subcommands: [{ name: '<name>', description: 'The server alias to unregister.' }],
  },

  // -- plugin --------------------------------------------------------------
  'plugin:add': {
    name: 'plugin:add',
    title: 'wstack plugin add <spec> — install a tool plugin',
    description:
      'Add a tool plugin by specifier (npm package name) or official alias ' +
      '(`telegram`, `lsp`). Pass `--disabled` to install the plugin but ' +
      'leave it off until you explicitly enable it. The plugin requires a ' +
      'restart of the wrongstack process to take effect.',
    usage: 'wstack plugin add <spec|alias> [--disabled]',
    subcommands: [
      {
        name: '<spec|alias>',
        description: 'NPM specifier (e.g. `@org/wrongstack-x`) or official alias.',
      },
      {
        name: '--disabled',
        description: 'Install the plugin but leave it disabled until you enable it.',
      },
    ],
    seeAlso: 'wstack plugin official (list the official registry); wstack plugin enable',
  },
  'plugin:remove': {
    name: 'plugin:remove',
    title: 'wstack plugin remove <spec> — uninstall a tool plugin',
    description:
      'Remove a tool plugin from the config. The plugin requires a restart ' +
      'of the wrongstack process to take effect. Aliases: `rm`, `uninstall`.',
    usage: 'wstack plugin remove <spec|alias>',
    subcommands: [
      { name: '<spec|alias>', description: 'The specifier or official alias to remove.' },
    ],
  },
  'plugin:enable': {
    name: 'plugin:enable',
    title: 'wstack plugin enable <spec> — re-enable a previously-disabled plugin',
    description:
      'Re-enable a plugin that was installed with `--disabled` or ' +
      'toggled off with `wstack plugin disable`. Requires a restart.',
    usage: 'wstack plugin enable <spec|alias>',
    subcommands: [
      { name: '<spec|alias>', description: 'The specifier or official alias to enable.' },
    ],
  },
  'plugin:disable': {
    name: 'plugin:disable',
    title: 'wstack plugin disable <spec> — temporarily disable a plugin',
    description:
      'Temporarily disable a plugin without removing it from the config. ' +
      'Use `wstack plugin enable` to re-enable. Requires a restart.',
    usage: 'wstack plugin disable <spec|alias>',
    subcommands: [
      { name: '<spec|alias>', description: 'The specifier or official alias to disable.' },
    ],
  },
  'plugin:toggle': {
    name: 'plugin:toggle',
    title: 'wstack plugin toggle <name> — toggle an audit-list plugin row',
    description:
      'Toggle one built-in audit-list plugin by its runtime name. Default-active ' +
      'plugins are disabled by writing `{ enabled: false }` overrides; enabling ' +
      'them again removes that override. All bundled audit-list rows are toggleable; ' +
      'future non-toggleable rows are reported as locked. ' +
      'Requires a restart for loaded plugin code to change in the current session.',
    usage: 'wstack plugin toggle <name>',
    subcommands: [
      { name: '<name>', description: 'Audit-list runtime name, e.g. `format-on-save`.' },
    ],
    seeAlso: 'wstack plugin report (see effective state and toggle policy)',
  },
  'plugin:report': {
    name: 'plugin:report',
    title: 'wstack plugin report — show the plugin audit table',
    description:
      'Print the built-in plugin audit table. Each row shows effective state, ' +
      'whether that state came from config or default boot behavior, risk, and ' +
      'the toggle policy for that row.',
    usage: 'wstack plugin report (alias: wstack plugin audit)',
    seeAlso: 'wstack plugin toggle <name> (toggle audit-list rows); wstack plugin list',
  },
  'plugin:menu': {
    name: 'plugin:menu',
    title: 'wstack plugin menu — open or describe the plugin picker',
    description:
      'In the TUI, `/plugin menu` opens the interactive plugin picker. From ' +
      'the non-interactive `wstack plugin menu` surface, the command prints ' +
      'the same audit report as `wstack plugin report`.',
    usage: 'wstack plugin menu',
    seeAlso: '/plugin menu (interactive picker in the TUI); wstack plugin report',
  },

  // -- models --------------------------------------------------------------
  // The `models:add` deep entry delegates its body to
  // `models-add-help.ts` via the `customBody` field. The flag
  // list lives in exactly one place (`MODELS_ADD_FLAGS`), and
  // every surface that renders the help — `wstack models add --help`,
  // `/models add help`, `/help models add` — produces the same
  // string. The `title` / `description` / `usage` / `seeAlso`
  // fields below are required by the `PerSubcommandHelp` shape
  // but never rendered (the `customBody` thunk owns the full
  // layout). They're filled in with sensible defaults so a
  // future refactor that drops `customBody` (e.g. to use the
  // standard layout) still has a coherent fallback.
  'models:add': {
    name: 'models:add',
    title: 'wstack models add <mid> — register a custom model',
    description: 'See renderModelsAddHelpToString() in models-add-help.ts for the full block.',
    usage: 'wstack models add <mid> [...flags]',
    customBody: renderModelsAddHelpToString,
  },
  'models:remove': {
    name: 'models:remove',
    title: 'wstack models remove <mid> — unregister a custom model',
    description:
      'Remove a custom model from the config. The catalog is unaffected ' +
      '(catalog models are managed by `wstack models refresh`).',
    usage: 'wstack models remove <mid>',
    subcommands: [{ name: '<mid>', description: 'The model id to remove.' }],
  },

  // -- audit / replay (--list deep-subcommand) ---------------------------
  'audit:list': {
    name: 'audit:list',
    title: 'wstack audit --list — list every session with an audit log',
    description:
      'Scan the project sessions dir for `.audit.jsonl` sidecars and ' +
      'print a one-line summary per session (entry count + chain status). ' +
      'Useful for finding a session to inspect with `wstack audit <id>`.',
    usage: 'wstack audit --list / wstack audit -l',
    seeAlso: "wstack audit <id> (inspect a single session's chain)",
  },
  'replay:list': {
    name: 'replay:list',
    title: 'wstack replay --list — list every session with a replay log',
    description:
      'Scan the project sessions dir for `.replay.jsonl` sidecars and ' +
      'print a one-line summary per session (entry count + log path). ' +
      'Useful for finding a session to inspect with `wstack replay <id>`.',
    usage: 'wstack replay --list / wstack replay -l',
    seeAlso: "wstack replay <id> (inspect a single session's recorded responses)",
  },

  // -- sessions (deep subcommands) ---------------------------------------
  'sessions:resume': {
    name: 'sessions:resume',
    title: 'wstack sessions resume [<id>] — resume a prior session',
    description:
      'Resume a session by id, or the most recent one if no id is given. ' +
      "The REPL replays the session's history into the new run so context " +
      'is preserved. Use the most recent id when the user just asked ' +
      '"pick up where we left off" without naming a specific session.',
    usage: 'wstack sessions resume [<id>]',
    subcommands: [
      { name: '[<id>]', description: 'Session id to resume (defaults to the most recent).' },
    ],
    seeAlso:
      'wstack sessions list (find a recent id); wstack sessions show <id> (preview before resuming)',
  },
  'sessions:fork': {
    name: 'sessions:fork',
    title: 'wstack sessions fork [<id>] [--to N] — branch a session journal',
    description:
      'Create a non-destructive child JSONL journal from the latest persisted ' +
      'boundary or checkpoint N. The parent is unchanged and the returned ' +
      'checkpoint hash identifies the exact parent event prefix. New Git-backed ' +
      'checkpoints also report a content-addressed workspace manifest, but the ' +
      'fork command does not apply it automatically: files remain shared until ' +
      'a host materializes that manifest into a separate clean checkout.',
    usage: 'wstack sessions fork [<id>] [--to N]',
    subcommands: [
      { name: '[<id>]', description: 'Parent session id (defaults to the most recent).' },
      { name: '--to N', description: 'Fork at checkpoint prompt index N.' },
    ],
    seeAlso: 'wstack rewind --list (find checkpoints); wstack sessions resume <child-id>',
  },
  'sessions:fleet': {
    name: 'sessions:fleet',
    title: 'wstack sessions fleet — list the active fleet of sessions',
    description:
      'List the active multi-agent fleet runs (the director, the ' +
      'subagent set, the iteration count, the journal size). Distinct ' +
      'from `wstack sessions list` which only shows single-agent ' +
      'sessions.',
    usage: 'wstack sessions fleet',
    seeAlso: 'wstack sessions list (single-agent sessions); /fleet (the in-REPL equivalent)',
  },
  'sessions:show': {
    name: 'sessions:show',
    title: 'wstack sessions show <id> — preview a session in detail',
    description:
      'Print the session metadata, the first N turns, the token/cost ' +
      'totals, and any errors. Use this to decide whether to resume a ' +
      'session before committing to it.',
    usage: 'wstack sessions show <id>',
    subcommands: [{ name: '<id>', description: 'The session id to show.' }],
  },
  'sessions:list': {
    name: 'sessions:list',
    title: 'wstack sessions list — list recent single-agent sessions',
    description:
      'Print a one-line summary per recorded session (id, timestamp, ' +
      'last prompt, model, token totals). Distinct from ' +
      '`wstack sessions fleet` which shows active multi-agent ' +
      'runs. Use this to find a session id to resume, show, or ' +
      'export.',
    usage: 'wstack sessions list',
    seeAlso: 'wstack sessions fleet (active runs); wstack sessions resume <id> (resume one)',
  },
  'sessions:config': {
    name: 'sessions:config',
    title: 'wstack sessions config — session-specific config',
    description:
      'Show or edit the session-specific config overrides (e.g. ' +
      'per-session provider + model). Subcommand: see the underlying ' +
      'config-history commands for the full surface — this is the ' +
      'shortcut alias.',
    usage: 'wstack sessions config',
  },

  // -- config (subcommands of the top-level config) ---------------------
  'config:show': {
    name: 'config:show',
    title: 'wstack config show — print the resolved config',
    description:
      'Print the resolved config (active profile plus all on-disk ' +
      'overrides applied) to stdout. Secrets are masked. The default ' +
      'subcommand — `wstack config` without a sub invokes this.',
    usage: 'wstack config show',
    seeAlso:
      'wstack config edit (interactive); wstack auth (most config edits are auth/key changes)',
  },
  'config:edit': {
    name: 'config:edit',
    title: 'wstack config edit — open the active profile config in $EDITOR',
    description:
      'Print the active profile config path (typically ' +
      '`~/.wrongstack/profiles/default/config.json`) and the command to open it. ' +
      'Does not spawn the editor itself — the user runs the printed ' +
      'command (or sets `$EDITOR` and re-runs). Useful for offline ' +
      'edits when you want to see the full file at once.',
    usage: 'wstack config edit',
    seeAlso: 'wstack config show (verify after edit); wstack config history (audit trail)',
  },
  'config:history': {
    name: 'config:history',
    title: 'wstack config history — list recent config-history entries',
    description:
      'List every recent change to the active profile config, with a ' +
      'one-line description and a snapshot id. Pass `--id <id>` to ' +
      'see the full diff + masked snapshot. The audit trail is ' +
      'append-only (entries are never modified post-creation).',
    usage: 'wstack config history [--id <id>]',
    subcommands: [
      { name: '<no subcommand>', description: 'List every history entry (newest first).' },
      { name: '--id <id>', description: 'Show the full diff + masked snapshot for one entry.' },
    ],
    seeAlso: 'wstack config restore <id>|--latest (revert); wstack config show (current state)',
  },
  'config:restore': {
    name: 'config:restore',
    title: 'wstack config restore <id>|--latest — revert to a prior config',
    description:
      'Restore a previous config-history entry. Pass either the ' +
      'history id (from `wstack config history`) or `--latest` to ' +
      'revert to the most recent prior version. A backup of the ' +
      'current config is created before the restore, so the change ' +
      'is itself recorded in the history (a history of histories).',
    usage: 'wstack config restore <id> | --latest / -l',
    subcommands: [
      {
        name: '<id>',
        description: 'The history id to restore (from `wstack config history` output).',
      },
      {
        name: '--latest / -l',
        description: 'Restore to the most recent prior version (without naming an id).',
      },
    ],
    seeAlso: 'wstack config history (list entries); wstack config show (verify the restore)',
  },

  // -- rewind (flag-shaped deep subcommands) ----------------------------
  'rewind:list': {
    name: 'rewind:list',
    title: 'wstack rewind --list — list rewind checkpoints for a session',
    description:
      'Print every checkpoint for the session (default: latest). ' +
      'Each checkpoint is a snapshot of the working tree + ' +
      'session history at a given prompt index. Use the checkpoint ' +
      'index as the value for `--to <idx>` when rewinding. Default ' +
      '`wstack rewind` (no flags) is an error — pair `--list` with ' +
      'a session id (positional) to discover available checkpoints ' +
      'first.',
    usage: 'wstack rewind [<sessionId>] --list',
    seeAlso: 'wstack rewind --to <idx> (rewind to a specific checkpoint); wstack rewind --all',
  },
  'rewind:all': {
    name: 'rewind:all',
    title: 'wstack rewind --all — rewind to the start of the session',
    description:
      'Rewind the working tree + session state to the very start ' +
      'of the session (the first prompt). Every file modified ' +
      'since the start is reverted. Pair with `--resume` to also ' +
      'truncate the session history at the start (so a fresh ' +
      '`wstack` invocation begins from there).',
    usage: 'wstack rewind [<sessionId>] --all [--resume]',
    seeAlso:
      'wstack rewind --last N (rewind fewer steps); wstack rewind --to <idx> (specific checkpoint)',
  },
  'rewind:last': {
    name: 'rewind:last',
    title: 'wstack rewind --last N — rewind the last N prompts',
    description:
      'Rewind the last `N` prompts. For a session that was on track ' +
      'for prompts 1..10 and went off the rails at 11..15, ' +
      '`--last 5` rewinds to the state at the end of prompt 10. ' +
      'Pair with `--resume` to truncate the history at the ' +
      'rewound point.',
    usage: 'wstack rewind [<sessionId>] --last <N> [--resume]',
    subcommands: [
      { name: '<N>', description: 'Number of recent prompts to rewind (must be ≥ 1).' },
    ],
    seeAlso: 'wstack rewind --all (rewind further); wstack rewind --to <idx> (precise checkpoint)',
  },
  'rewind:to': {
    name: 'rewind:to',
    title: 'wstack rewind --to <idx> — rewind to a specific checkpoint',
    description:
      'Rewind to checkpoint at the given prompt index (from ' +
      '`wstack rewind --list`). The most precise rewind form — ' +
      'lets you step back to exactly the state at a specific prompt ' +
      'rather than the bulk `--all` or approximate `--last N`.',
    usage: 'wstack rewind [<sessionId>] --to <idx> [--resume]',
    subcommands: [
      {
        name: '<idx>',
        description:
          'Prompt index to rewind to (must be ≥ 0). Use `wstack rewind --list` to find indices.',
      },
    ],
    seeAlso:
      'wstack rewind --list (find checkpoint indices); wstack rewind --resume (truncate history at the checkpoint)',
  },
  'rewind:resume': {
    name: 'rewind:resume',
    title: 'wstack rewind --resume — truncate session history at the checkpoint',
    description:
      'After the rewind (any of `--all` / `--last N` / `--to N`), ' +
      "also truncate the session's recorded history at the " +
      'rewound checkpoint so the next `wstack` invocation begins ' +
      'fresh from there. Without `--resume`, the rewind only ' +
      'reverts the working tree — the session history is preserved ' +
      "(you'd see the rewind point as a checkpoint in subsequent " +
      'runs).',
    usage: 'wstack rewind [<sessionId>] {--all|--last <N>|--to <idx>} --resume',
    seeAlso:
      'wstack rewind --list (find checkpoints); wstack sessions resume <id> (resume a rewound session)',
  },

  // -- mcp:restart (REPL-only) -----------------------------------------
  'mcp:restart': {
    name: 'mcp:restart',
    title: 'wstack mcp restart — restart a running MCP server (REPL only)',
    description:
      'Restart a single running MCP server by alias. This subcommand ' +
      'is only meaningful inside the REPL (`wstack` with no ' +
      '`<task>` argument) — from the top-level CLI it prints a ' +
      "warning and exits 0 because there's no live process to " +
      'restart. Use the `/mcp restart <name>` slash command from ' +
      'inside the REPL.',
    usage: 'wstack mcp restart <name> (REPL only)',
    seeAlso:
      '/mcp restart <name> (the in-REPL slash command); wstack mcp remove + wstack mcp add (replace the server config)',
  },

  // -- plugin (list / official) -----------------------------------------
  'plugin:list': {
    name: 'plugin:list',
    title: 'wstack plugin list — list configured plugins',
    description:
      'Print every plugin registered in the config, grouped by ' +
      'enabled vs disabled. Alias: `plugin status`. For the ' +
      'official registry (a curated list maintained by the ' +
      'WrongStack project), use `wstack plugin official` instead.',
    usage: 'wstack plugin list (alias: wstack plugin status)',
    seeAlso:
      'wstack plugin official (curated registry); wstack plugin enable / disable (toggle state)',
  },
  'plugin:official': {
    name: 'plugin:official',
    title: 'wstack plugin official — list the curated official registry',
    description:
      'Print every plugin in the official registry (currently ' +
      '`telegram` and `lsp`). Each row shows the alias (for ' +
      'shorthand on the command line) and the full NPM specifier ' +
      '(what `wstack plugin add <spec>` actually installs). ' +
      'Aliases: `plugin officials` (plural).',
    usage: 'wstack plugin official (alias: wstack plugin officials)',
    seeAlso: 'wstack plugin add <alias> (install one); wstack plugin list (what you have)',
  },
  'plugin:officials': {
    // The plural form `plugin officials` is accepted as an
    // alias of `plugin official` in the underlying dispatch
    // (`plugin-management.ts`). The deep-help table mirrors
    // the alias so `wstack plugin officials --help` and
    // `wstack plugin official --help` both render the same
    // focused block.
    name: 'plugin:officials',
    title: 'wstack plugin officials — list the curated official registry (plural alias)',
    description:
      'Alias of `wstack plugin official`. Prints every plugin in ' +
      'the official registry. Same output as the singular form.',
    usage: 'wstack plugin officials (plural alias of `wstack plugin official`)',
    seeAlso: 'wstack plugin official (the singular form)',
  },

  // -- models (refresh + list) -----------------------------------------
  'models:refresh': {
    name: 'models:refresh',
    title: 'wstack models refresh — force-refresh the models.dev cache',
    description:
      'Re-fetch the models.dev catalog and replace the cached ' +
      '`models.json` in the global config dir. Useful when a new ' +
      'model is published mid-session and you want to see it in ' +
      '`wstack providers` / `wstack models` without restarting. ' +
      'The cache age is shown in the footer of every `wstack models` ' +
      'listing so you know when to refresh.',
    usage: 'wstack models refresh',
    seeAlso:
      'wstack models <provider> (list models after refresh); wstack providers (force-refresh the provider catalog)',
  },
  'models:list': {
    name: 'models:list',
    title: 'wstack models list — list custom models registered locally',
    description:
      "Print every model that's been added via `wstack models add` " +
      "(i.e. the entries in `config.json`'s `models` section, not " +
      'the catalog). Distinct from `wstack models <provider>` which ' +
      'lists the catalog for a specific provider. The list is the ' +
      'audit surface for self-hosted / fine-tuned / overridden ' +
      'models.',
    usage: 'wstack models list',
    seeAlso:
      'wstack models <provider> (catalog); wstack models add <mid> (register a custom model)',
  },

  // -- auth (list / status / remove) -------------------------------------
  // The top-level `wstack auth` entry in `helpTable` lists the
  // subcommands; these deep entries give each one its own focused
  // block so `wstack auth list --help`, `/help auth status`, and
  // `/auth status help` all render the same string the underlying
  // handler would emit. The descriptions match the actual
  // handler behavior in `packages/cli/src/subcommands/handlers/auth.ts`
  // — note that the `remove` subcommand is always interactive
  // (prompts for confirmation); the `[--force]` token in the
  // handler's error message is a documented hint that is not
  // yet wired up in the parser.
  'auth:list': {
    name: 'auth:list',
    title: 'wstack auth list — list saved providers and key status',
    description:
      'Read-only listing of every provider in the active profile config. ' +
      'Each provider block shows the family, baseUrl, model-allowlist size, ' +
      'and the saved API keys (the active key is marked with a green `●`, ' +
      'inactive keys with a dim `○`; all values are masked). Alias: ' +
      '`wstack auth ls`.',
    usage: 'wstack auth list (alias: wstack auth ls)',
    subcommands: [
      { name: 'list', description: 'List every saved provider (this command).' },
      { name: 'ls', description: 'Alias of list.' },
    ],
    seeAlso:
      'wstack auth status <id> (detail for one provider); wstack auth remove <id> (delete one)',
  },
  'auth:status': {
    name: 'auth:status',
    title: 'wstack auth status <provider> — show detail for one provider',
    description:
      'Print the full `config.json` entry for a single provider: ' +
      'type, family, baseUrl, the `models` allowlist, the `envVars` ' +
      'list, and every saved key (active key marked with a green ' +
      '`●`, masked value, ISO timestamp). The provider id is ' +
      'required as a positional — `wstack auth status` with no id ' +
      'prints the usage hint and exits 1.',
    usage: 'wstack auth status <provider>',
    subcommands: [
      {
        name: '<provider>',
        description: 'The provider id to inspect (e.g. `openai`, `anthropic`).',
      },
    ],
    seeAlso:
      'wstack auth list (find the id); wstack auth remove <id> (delete it); wstack auth (interactive edit)',
  },
  'auth:remove': {
    name: 'auth:remove',
    title: 'wstack auth remove <provider> — delete a provider and its keys',
    description:
      'Remove a provider entry and all its saved API keys from ' +
      'the active profile config. The flow is always interactive: ' +
      'after printing a confirmation prompt the handler waits for ' +
      "a `y` / `yes` answer (default `N`). The active session's " +
      'in-memory provider is NOT reloaded — restart the REPL to ' +
      'fully tear down a running provider. Alias: `wstack auth rm`.',
    usage: 'wstack auth remove <provider> (alias: wstack auth rm <provider>)',
    subcommands: [
      { name: '<provider>', description: 'The provider id to remove.' },
      { name: 'rm', description: 'Alias of remove.' },
    ],
    seeAlso:
      'wstack auth list (find the id); wstack auth status <id> (inspect before removing); wstack auth <provider> (re-add a different one)',
  },
  // The `auth:local` deep entry delegates its body to
  // `auth-local-help.ts` via the `customBody` field. The flag
  // list lives in exactly one place (`LOCAL_AUTH_FLAGS`), and
  // every surface that renders the help — `wstack auth local --help`,
  // `/auth local help`, `/help auth local` — produces the same
  // string. The `title` / `description` / `usage` / `seeAlso` fields
  // below are required by the `PerSubcommandHelp` shape but
  // never rendered (the `customBody` thunk owns the full layout).
  // They're filled in with sensible defaults so a future refactor
  // that drops `customBody` (e.g. to use the standard layout)
  // still has a coherent fallback.
  'auth:local': {
    name: 'auth:local',
    title: 'wstack auth local — quick-add Ollama / vLLM / LM Studio',
    description:
      'Pre-fills the base URL, runs a health probe, and persists ' +
      'the allowlist so you can `wstack --provider <id>` right away. ' +
      'Use `--no-probe` to skip the probe when the server is not ' +
      'running yet; `--audit <file>` captures the save lifecycle as ' +
      'JSONL.',
    usage:
      'wstack auth local [--name <id>] [--base-url <url>] [--no-key] [--no-probe|--probe-only] [--model <spec>] [--audit [target]]',
    seeAlso: 'wstack auth (interactive menu); wstack auth <provider> (catalog add)',
    customBody: renderAuthLocalHelpToString,
  },

  // -- bench (run — delegated to bench-run-help.ts via customBody) ------
  // The `bench:run` deep entry delegates its body to
  // `bench-run-help.ts` via the `customBody` field. The flag
  // list lives in exactly one place (`BENCH_RUN_FLAGS`), and
  // every surface that renders the help — `wstack bench run --help`,
  // `/bench run help`, `/help bench run` — produces the same
  // string. The `title` / `description` / `usage` / `seeAlso`
  // fields below are required by the `PerSubcommandHelp` shape
  // but never rendered (the `customBody` thunk owns the full
  // layout). They're filled in with sensible defaults so a
  // future refactor that drops `customBody` (e.g. to use the
  // standard layout) still has a coherent fallback.
  'bench:run': {
    name: 'bench:run',
    title: 'wstack bench run — execute a benchmark suite across a model matrix',
    description: 'See renderBenchRunHelpToString() in bench-run-help.ts for the full block.',
    usage: 'wstack bench run [...flags]',
    customBody: renderBenchRunHelpToString,
  },
};
