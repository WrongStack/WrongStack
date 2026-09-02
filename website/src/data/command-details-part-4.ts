import { surfaceListSentence } from './command-detail-types';
import type { CommandDetailMap } from './command-detail-types';

export const commandDetailsPart4: CommandDetailMap = {
  '/mcp': {
    purpose:
      'Add, update, discover, restart, and inspect MCP servers — extend WrongStack with external tool providers.',
    behavior:
      'MCP (Model Context Protocol) servers expose tools from external sources (GitHub, filesystem, databases, APIs). `/mcp list` shows connected servers. `/mcp add` registers a new server. `/mcp discover <name>` searches the MCP registry. `/mcp restart <name>` reconnects. `/mcp inspect <name>` shows registered tools.',
    before:
      'Ensure the MCP server is installed and reachable. Some servers require authentication.',
    during: 'Server status shows connection state and tool count. Discovery searches the registry.',
    after:
      'Verify tools are registered with `/tools`. Restart servers that show connection errors.',
  },

  '/telegram-setup': {
    purpose:
      'Configure a Telegram bot token and default chat — enable Telegram notifications and approvals.',
    behavior:
      'The command guides you through setting up Telegram integration: creating a bot via BotFather, entering the token, and setting a default chat ID. Once configured, the agent can send notifications, request approvals, and receive commands through Telegram.',
    before: 'Create a Telegram bot via @BotFather and have the token ready.',
    during: 'The setup wizard prompts for token and chat ID. Validation confirms connectivity.',
    after:
      'Send a test message with `/telegram-settings test`. Approvals can be requested with the telegram_approve tool.',
  },

  '/telegram-settings': {
    purpose: 'Tune Telegram notification preferences — control what events trigger messages.',
    behavior:
      'The command shows and configures notification preferences: which events trigger Telegram messages (task completion, error, approval request, milestone), notification priority thresholds, and quiet hours. `/telegram-settings test` sends a test message to verify connectivity.',
    before:
      'Decide which events warrant a notification. Too many notifications reduce their value.',
    during: 'Settings print with current values. Changes apply immediately.',
    after:
      'Send a test message to confirm delivery. Adjust preferences based on notification volume.',
  },

  '/prompts': {
    purpose:
      'Manage the layered project, user, and bundled prompt library — organize reusable prompt templates.',
    behavior:
      'WrongStack maintains a layered prompt library: bundled (shipped with WrongStack), active profile (~/.wrongstack/profiles/<name>/prompts), and project (.wrongstack/prompts). `/prompts` lists all prompts with their source layer. Prompts can be searched, favorited, and inserted into the agent context. Layers merge by slug; profile overrides project, project overrides bundled.',
    before: 'No preparation needed. Browse prompts to see what templates are available.',
    during: 'The prompt list shows slugs, titles, source layers, and favorite status.',
    after: 'Insert a prompt with `/prompt <slug>`. Create new prompts with `/prompt-gen`.',
  },

  '/prompt': {
    purpose:
      'Search and insert a reusable prompt — inject a pre-written steering template into the agent context.',
    behavior:
      '`/prompt search <query>` finds matching prompts by title, tag, or content. `/prompt <slug>` inserts that prompt into the next agent turn. Prompts can contain variables that are rendered at insertion time. Favorited prompts appear first in search results.',
    before: 'Browse available prompts with `/prompts` or search with `/prompt search`.',
    during:
      'Search results show relevance-ranked prompts. Insertion renders variables and adds the prompt to context.',
    after:
      'The inserted prompt steers the next agent turn. Edit or remove it if the effect is not what you wanted.',
  },

  '/prompt-gen': {
    purpose:
      'Author a reusable prompt with model assistance — create high-quality steering templates.',
    behavior:
      'The command opens a prompt authoring workflow. Describe what you want the prompt to do, and the model generates a draft with proper structure, variables, and metadata. You can refine iteratively before saving. Generated prompts are stored in the user or project layer.',
    before: 'Have a clear idea of the steering behavior you want to capture as a reusable prompt.',
    during:
      'The model generates a draft. You review and iterate. The final version is saved with a slug.',
    after: 'Test the prompt with `/prompt <slug>`. Refine with `/prompt-gen` again if needed.',
  },

  '/sync': {
    purpose:
      'Sync selected settings, skills, prompts, memory, and history through GitHub — keep machines in sync.',
    behavior:
      'WrongStack can sync configuration artifacts through a GitHub repository. `/sync` shows sync status. `/sync push` uploads local changes. `/sync pull` downloads remote changes. `/sync configure` sets the repository. Conflicts are detected and reported before overwriting.',
    before: 'Create a GitHub repository for sync. Configure it with `/sync configure <repo-url>`.',
    during: 'Push and pull show file-level changes. Conflicts are flagged with diff output.',
    after:
      'Verify synced artifacts on the other machine. Run `/sync pull` there to receive changes.',
  },

  '/metrics': {
    purpose:
      'Show a metrics snapshot when observability is enabled — track agent performance over time.',
    behavior:
      'When the observability plugin is active, `/metrics` prints a dashboard of key metrics: session count, average tokens per session, tool success rate, model latency, cost per session, and fleet utilization. Metrics are collected in the background with minimal overhead.',
    before: 'Enable observability in settings. Metrics collection starts automatically.',
    during: 'The dashboard prints with current values and trend indicators.',
    after:
      'Use metrics to identify inefficient patterns. Adjust model choices or workflow based on data.',
  },

  '/health': {
    purpose:
      'Run registered health checks when observability is enabled — verify system integrity.',
    behavior:
      'Health checks validate critical subsystems: database connectivity, provider reachability, plugin integrity, permissions policy coherence, and file system access. `/health` runs all checks. `/health <check-name>` runs a specific check. Failures include diagnostic information.',
    before:
      'Enable observability in settings. Health checks are lightweight and safe to run anytime.',
    during: 'Checks run sequentially. Each prints a pass/fail status with timing.',
    after:
      'Investigate any failing checks. The diagnostic output usually points directly to the root cause.',
  },

  '/skill': {
    purpose:
      'List discovered skills or load one skill body — browse and activate WrongStack extensions.',
    behavior:
      'Skills extend WrongStack with specialized knowledge and workflows. `/skill` lists all discovered skills (bundled, user-installed, project). `/skill <name>` loads and displays a skill full instruction body. Skills auto-activate when their trigger words appear in your request.',
    before: 'No preparation needed. Browse skills to discover available capabilities.',
    during:
      'The skill list shows names, sources, and trigger descriptions. Loading shows the full skill body.',
    after: 'Use skill trigger words in your prompts. Install new skills with `/skill-install`.',
  },

  '/skill-gen': {
    purpose: 'Author a new skill with model guidance — create custom WrongStack extensions.',
    behavior:
      'The command guides you through skill creation: define the trigger words, write the instruction body, set capability requirements, and choose the storage location. The model helps draft the skill content based on your description. Generated skills are immediately available.',
    before: 'Define what the skill should do and what words should trigger it.',
    during:
      'The authoring workflow steps through metadata, trigger configuration, and content generation.',
    after:
      'Test the skill by using its trigger words. Refine with `/skill-gen` if the behavior needs adjustment.',
  },

  '/skill-search': {
    purpose: 'Search the configured skill registry — find skills by name, tag, or capability.',
    behavior:
      '`/skill-search <query>` searches across all skill sources: the official registry, GitHub, and local installations. Results show skill name, description, tags, author, and installation status. You can filter by source or capability.',
    before: 'Have a capability or task type in mind. The search supports natural language queries.',
    during: 'Results appear ranked by relevance. Already-installed skills are marked.',
    after: 'Install interesting skills with `/skill-install`. Verify with `/skill <name>`.',
  },

  '/skill-install': {
    purpose: 'Install a skill from GitHub or the registry — add new capabilities to WrongStack.',
    behavior:
      '`/skill-install user/repo` installs from a GitHub repository. `/skill-install registry:<id>` installs from the official registry. The skill is downloaded, validated, and registered. Installation can be project-scoped or user-scoped. Dependencies are checked before installation.',
    before: 'Verify the skill source is trustworthy. Review its description and capabilities.',
    during: 'Download and validation progress prints. Registration confirms the skill is active.',
    after: 'Verify installation with `/skill <name>`. Test the skill by using its trigger words.',
  },

  '/skill-import': {
    purpose:
      'Import compatible skills from supported foreign locations — bring skills from other AI coding tools.',
    behavior:
      'The command discovers and imports skills from Claude Code, Aider, Continue, and other compatible tools. `/skill-import` scans known locations. `/skill-import <path>` imports from a specific directory. Imported skills are adapted to WrongStack conventions.',
    before: 'Ensure the foreign tool skills are in their standard locations.',
    during: 'Discovery lists found skills. Import adapts and registers them.',
    after: 'Review imported skills — some foreign conventions may need manual adjustment.',
  },

  '/skill-update': {
    purpose: 'Update installed skills — get the latest versions with bug fixes and new features.',
    behavior:
      '`/skill-update` checks all installed skills for updates. `/skill-update <name>` updates a specific skill. Updates preserve local modifications where possible. The changelog (if available) is shown before updating.',
    before: 'Review what changed in the skill update. Some updates may change behavior.',
    during: 'Update progress shows download and validation. The changelog prints if available.',
    after:
      'Verify updated skills still work as expected. Roll back if the update breaks functionality.',
  },

  '/skill-uninstall': {
    purpose: 'Remove an installed skill — clean up unused or problematic extensions.',
    behavior:
      '`/skill-uninstall <name>` removes a skill and its registration. User data created by the skill is preserved. The command confirms before removal. Bundled skills cannot be uninstalled — they can only be disabled.',
    before:
      'Confirm you no longer need the skill. Uninstallation is reversible only by reinstalling.',
    during: 'Confirmation prompt appears. Removal is instant after confirmation.',
    after:
      'Verify the skill no longer appears in `/skill list`. Reinstall with `/skill-install` if needed.',
  },

  '/profile': {
    purpose:
      'Manage configuration profiles — isolate provider credentials, fallback chains and feature flags per workflow.',
    behavior: `Each profile lives at \`~/.wrongstack/profiles/<name>/config.json\`. The active profile is recorded in the bootstrap config. \`/profile list\` shows available profiles (the active one is marked with a bullet). \`/profile switch <name>\` activates a profile and broadcasts \`config.changed\` to every surface — ${surfaceListSentence} — so every client reconnects to the new config. \`/profile copy <name>\` duplicates the active profile into a new name you can edit independently. Profile names are sanitized for path safety — the characters \`/\`, \`\\\`, \`:\`, \`.\`, and \`_\` are each replaced with \`_\` (and an empty result is rejected), so a name like \`..\` collapses to a single underscore and \`my:profile\` becomes \`my_profile\`. The user-facing error names these chars for reference.`,
    before:
      'Decide whether you want multiple profiles. Most teams keep one `default` profile and add `work` or `experiment` profiles to switch between provider credentials, autonomy levels or feature flags without touching the global config.',
    during: `\`/profile switch <name>\` is the dangerous mutation — it changes the active provider, model and fallback chain for every open surface (${surfaceListSentence}). The output lists the old and new active profile plus the side-effects broadcast.`,
    after: `Confirm the active profile (the bullet in \`/profile list\`) and re-check \`/auth\` plus \`/setmodel\` so the right credentials and leader model are wired across every open surface (${surfaceListSentence}).`,
  },

  '/provider-status': {
    purpose:
      'View live health for every configured provider/model route — see what is healthy, degraded, blocked, or waiting.',
    behavior:
      'The `ProviderModelStatusTracker` records every failure and success against a `(provider, model)` pair and assigns a state: `healthy`, `degraded`, `blocked`, or `waiting` (with an expiry). The command can show all statuses, filter by state, release a single blocked pair back into the rotation with `retry`, or clear all tracked state with `clear`. When the tracker is unwired, the command reports an honest "tracker unavailable" message instead of inventing data.',
    before:
      'Run when a model feels stuck, when the fallback chain is rotating too often, or after a quota event. Useful before reporting a routing issue.',
    during:
      'The state list prints once. `retry <provider> <model>` triggers a half-open probe on the next use, releasing the entry without restarting the session.',
    after:
      'Healthy models stay in the rotation. Degraded models keep working but are demoted. Blocked models are skipped until the cooldown expires or a manual release is issued.',
  },

  '/chimera': {
    purpose:
      'Show Chimera — the post-session code-quality guardian — and adjust its review settings for the current session.',
    behavior:
      'Chimera is a built-in plugin, on by default, that runs after each session ends. It collects the changed files and dispatches a focused subagent (`extensions.wstack-chimera.provider/model`) to find bugs, anti-patterns, security smells and review suggestions. Severity-ranked findings appear in a structured report. With `autoFix=auto`, Chimera can also dispatch a follow-up fix subagent. `/chimera autoFix <off|ask|auto>` adjusts the mode in-session without rewriting the config file; the change is recorded via a `chimera.set_autofix` event so the leader reflects it immediately.',
    before:
      'Decide whether you want review findings sent as a `note`, surfaced as an interactive `ask`, or auto-fixed. `off` keeps the report on the review report only.',
    during:
      'The command prints provider, model, max files, autoFix mode, cascadeOn and maxCascadeDepth. Setting `autoFix ask` causes Chimera to send each finding as an actionable ask so you can approve or reject fixes one at a time.',
    after: `Reports are persisted to the session JSONL and broadcast on mailbox so every open surface (${surfaceListSentence}) can render them.`,
  },

  '/auto-review': {
    purpose:
      'Show the continuous auto-review pipeline — fire a focused review subagent on every detected git change during a session.',
    behavior:
      'Auto-review watches git-tracked file edits (debounced, default 5 s) and dispatches a review subagent with the configured provider and model. When a finding exceeds the `cascadeOn` threshold (`off` | `high` | `critical`), follow-up agents (`security-scanner`, `bug-hunter`) are spawned to investigate and propose fixes. The cycle is bounded by `maxCascadeDepth` (default 2). The active config lives under `extensions.wstack-auto-review` in the active profile config; `enabled`, `provider`, `model`, `fallbackProfile`, `debounceMs`, `maxFilesPerBatch`, `maxConcurrentReviews`, `cascadeOn` and `maxCascadeDepth` can each be tuned. Bare `/auto-review` prints the current effective config and any in-flight reviews; `on` / `off` report that enable/disable happens by editing config.json (so the change is durable across sessions).',
    before:
      'Pick a fallback profile and a sane threshold. Cascade at `high` is usually the right default; pick `critical` if you only want follow-ups for severe findings.',
    during:
      '`enable` and `disable` subcommands print that the change happens through `extensions.wstack-auto-review.enabled` in `config.json` — they do not flip a runtime flag.',
    after: `In-flight count, provider, model, fallback chain, debounce window, max files, max parallel, cascade policy and max depth are printed for transparency.`,
  },

  '/semver': {
    purpose:
      'Show the current version, the latest git tag, and the conventional-commit-suggested bump — or apply a forced bump (`patch` | `minor` | `major` | `auto`).',
    behavior:
      '`/semver status` reads `package.json`, the latest git tag, and the conventional commits since that tag; the suggested bump is inferred from the type prefixes (`feat:` → minor, `fix:` → patch, `BREAKING CHANGE:` → major). `/semver patch|minor|major` forces a specific bump and writes a commit + tag. `/semver auto` defers to the inference. `cwd` is always contained inside the project root — a path that escapes fails closed. The companion `semver_bump`, `semver_current`, and `semver_changelog` tools are what the agent loop invokes for automated versioning and changelog generation (markdown grouped by conventional-commit type, between any two tags or from a tag to HEAD).',
    before:
      'Decide between forced and inferred bumps. Forced bumps are right for hotfixes; inferred bumps preserve the conventional-commit contract.',
    during:
      'Each mode prints progress. `--dry` (alias `--dry-run`) previews without writing or tagging.',
    after:
      'The new tag is recorded and reusable by `semver_changelog` for the next release notes draft. The lockstep invariant is that all workspace manifests, the website release copy, and the lockstep version script update together.',
  },

  '/lsp': {
    purpose:
      'Manage Language Server Protocol servers — list, install, start, stop, restart and inspect diagnostics.',
    behavior:
      '`/lsp` (alias `lsplsp`) is the umbrella command. `/lsp list` enumerates configured servers. `/lsp status` reports alive/dead state. `/lsp install <language>` wires up a canonical language server (the supported languages cover TypeScript, Python, Go, Rust and more). `/lsp start|stop|restart [name]` manages individual server processes. `/lsp diagnostics [file]` prints buffered diagnostics for a file or globally. `/lsp add <name> ...` registers an ad-hoc server; `/lsp remove`, `/lsp enable` and `/lsp disable` curate the registry. Subcommands accept short aliases (`ls`, `stat`, `diag`, `rm`).',
    before:
      'Have a project with a recognized root pattern (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, etc.) so LSP root detection lands on the right directory.',
    during:
      'Install and restart print server stderr and exit codes; use `/lsp status` to verify alive. Diagnostics stream into the WebUI CodeMap activity layer so refactors land safely.',
    after:
      'Document symbols surface through `codebase-search` with `preferLsp: true`; the deprecated `codebase-lsp-search` tool is replaced by that flag.',
  },
};
