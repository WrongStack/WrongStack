import { OPERATIONS_HELP_ENTRIES } from './per-subcommand-help-operations.js';
import type { PerSubcommandHelp } from './per-subcommand-help-types.js';

export const helpTable: Record<string, PerSubcommandHelp> = {
  automation: {
    name: 'automation',
    title: 'wstack automation — persistent agent jobs',
    description:
      'Manage persistent schedules, signed GitHub intake, isolated runs and run history.',
    usage:
      'wstack automation <add|preview|templates|import|export|list|run|enable|disable|cancel|serve|prune> [id] [options]',
    seeAlso: 'docs/subcommands/automation.md',
  },
  sandbox: {
    name: 'sandbox',
    title: 'wstack sandbox — isolated Docker execution',
    description:
      'Run the full agent in a copied project workspace and retain a patch without editing the host project.',
    usage:
      'wstack sandbox docker --image <trusted-image> --prompt <task> [--dry-run] [--env NAME,...] [--provider id] [--model id] [--out directory]',
    seeAlso: 'docs/subcommands/sandbox.md',
  },
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
          'Run the wstack MCP server (read-only; --allow <caps> or --yolo widens); --resources/--prompts expose selected files.',
      },
      {
        name: 'serve <mailbox|kanban|codebase-index|requirement-intake|sage>',
        description:
          "Run one of this project's MCP servers over stdio (works in the standalone binary). " +
          '--project-root defaults to the current project; other flags pass through.',
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
    usage: 'wstack config [show|edit|backup|history|restore] [...]',
    subcommands: [
      { name: 'show', description: 'Print the resolved config to stdout (default).' },
      { name: 'edit', description: 'Open the active profile config in $EDITOR.' },
      { name: 'backup', description: 'Create a recoverable snapshot of the active profile.' },
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
      'wstack auth [list|status|remove|cloud] [...] | wstack auth <provider> | wstack auth local [...]',
    subcommands: [
      { name: 'list', description: 'List saved providers and key status.' },
      { name: 'status <id>', description: 'Show detail for one provider.' },
      {
        name: 'cloud <id>',
        description:
          'Read or set native region/project/location/resource routing for a saved profile.',
      },
      { name: 'remove <id>', description: 'Remove a provider and its keys.' },
      { name: '<provider>', description: 'Add a key for a named provider (--label, --family, …).' },
      {
        name: 'local',
        description:
          'Pre-fill Ollama / vLLM / LM Studio (--name, --base-url, --no-probe, --model, --audit …).',
      },
      {
        name: 'login <chatgpt|copilot>',
        description:
          'Subscription OAuth login: chatgpt (→ openai-codex) or copilot (→ github-copilot). Claude has no third-party sign-in: use `wstack auth anthropic` with an API key (Max/Team plans include monthly API credits). Opens browser; no API key. ⚠ Using subscriptions outside official clients may violate provider ToS (account ban risk); an API key is the sanctioned path.',
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
    usage: 'wstack sessions [list|show|resume|fork|move|doctor|config|fleet] [...]',
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
      {
        name: 'move <id> --to <path>',
        description:
          'Move a closed session to another git worktree of this repository, or to ' +
          'another project (its journal moves to that project).',
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
    title: 'wstack tools — list registered tools, or call one from outside a session',
    description:
      'Bare: list every registered tool with owner and permission. list/describe/run/batch: ' +
      'call built-in tools from any script or external agent. Read-only unless --allow <caps> ' +
      '(e.g. fs.write) or --yolo. Exit: 0 ok, 1 failed, 2 bad input, 3 not exposed/denied, 4 needs confirmation.',
    usage:
      'wstack tools [catalog [--check]|list|describe <tool>|run <tool> [--input <json|@file|stdin>] [-- --<field> <value>]|batch|agent-guide] [--json] [--allow <caps>|--yolo]',
    subcommands: [
      {
        name: 'catalog',
        description:
          'Export registered tool contracts as JSON; --check fails on declaration issues. Includes session-bound tools, not an execution grant.',
      },
      { name: 'list', description: 'Tools callable from outside a session, one line each.' },
      { name: 'describe <tool>', description: 'Description, capabilities and input JSON schema.' },
      {
        name: 'run <tool>',
        description:
          '--input <json>|@file.json|bare (stdin); schema fields after --: -- --path a.ts --limit 5.',
      },
      {
        name: 'batch',
        description:
          'JSONL calls ({"tool","input","id"}) on stdin or --input @f; one result line each.',
      },
      {
        name: 'agent-guide',
        description:
          "A short Markdown guide for an agent's instruction file (AGENTS.md, CLAUDE.md).",
      },
      {
        name: 'serve',
        description:
          'REST for an external agent: GET /v1/tools, POST /v1/tools/<name>/call; --port 0, token required.',
      },
    ],
    seeAlso: 'wstack mcp serve (the same tools over MCP), wstack skills',
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

  ...OPERATIONS_HELP_ENTRIES,
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
