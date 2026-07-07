# Slash Commands - Overview

WrongStack's REPL supports core slash commands plus commands registered by built-in plugins. Commands are registered into `SlashCommandRegistry`, dispatched by name, and wired with a shared `SlashCommandContext`.

## Core command map

| Command | Source | What it does |
|---|---|---|
| `/help` | `packages/cli/src/slash-commands/help.ts` | List all commands; show detailed help for a named command |
| `/init` | `packages/cli/src/slash-commands/init.ts` | Create or update `.wrongstack/AGENTS.md` |
| `/clear` | `packages/cli/src/slash-commands/clear.ts` | Wipe session state and terminal view |
| `/compact` | `packages/cli/src/slash-commands/compact.ts` | Run the context-window compactor |
| `/context` | `packages/cli/src/slash-commands/context.ts` | Context summary, repair, mode, and limit controls; `/ctx` alias |
| `/dev` | `packages/cli/src/slash-commands/dev.ts` | Run a shell command and see output (LLM does not see it) |
| `/codebase-reindex` | `packages/cli/src/slash-commands/codebase-reindex.ts` | Rebuild the codebase symbol index; `/reindex` alias |
| `/techstack` | `packages/cli/src/slash-commands/techstack.ts` | Scan dependencies, verify versions, write techstack report; `/tech`, `/deps` aliases |
| `/diag` | `packages/cli/src/slash-commands/diag-stats.ts` | Runtime diagnostics |
| `/stats` | `packages/cli/src/slash-commands/diag-stats.ts` | Session report |
| `/memory` | `packages/cli/src/slash-commands/memory.ts` | Persistent memory: show, remember, forget, clear |
| `/todos` | `packages/cli/src/slash-commands/todos.ts` | Session todo list |
| `/tasks` | `packages/cli/src/slash-commands/tasks.ts` | Structured task management with dependencies and priorities |
| `/mode` | `packages/cli/src/slash-commands/mode.ts` | Switch or view session mode; includes token-saving lite and deep/full mode families |
| `/setmodel` | `packages/cli/src/slash-commands/setmodel.ts` | View or set leader model and per-task model matrix |
| `/models` | `packages/cli/src/slash-commands/models.ts` | Manage custom model definitions |
| `/modelcaps` | `packages/cli/src/slash-commands/modelcaps.ts` | Browse model capacities and pricing across providers |
| `/yolo` | `packages/cli/src/slash-commands/yolo.ts` | Toggle or query YOLO mode |
| `/autonomy` | `packages/cli/src/slash-commands/autonomy.ts` | Set autonomy level |
| `/goal` | `packages/cli/src/slash-commands/goal.ts` | Set, show, pause, resume, journal, or clear an autonomous mission |
| `/save` | `packages/cli/src/slash-commands/session.ts` | Force-flush session to disk |
| `/sessions` | `packages/cli/src/slash-commands/session.ts` | List recent sessions; `/resume`, `/load` aliases for backward compat |
| `/prune` | `packages/cli/src/slash-commands/prune.ts` | Delete old sessions; `/prune --dry-run` to preview |
| `/exit` | `packages/cli/src/slash-commands/session.ts` | Exit REPL; `/quit`, `/q` aliases |
| `/tool` | `packages/cli/src/slash-commands/tool.ts` | Configure per-tool description detail (`simple` or `extend`) |
| `/tools` | `packages/cli/src/slash-commands/tools.ts` | List registered tools |
| `/plugin` | `packages/cli/src/slash-commands/plugin.ts` | Manage plugins |
| `/mcp` | `packages/cli/src/slash-commands/mcp.ts` | Manage MCP servers |
| `/auth` | `packages/cli/src/slash-commands/auth.ts` | API key status dashboard; run `wstack auth` for full key manager |
| `/spawn` | `packages/cli/src/slash-commands/spawn-agents.ts` | Spawn an isolated subagent |
| `/agents` | `packages/cli/src/slash-commands/agents.ts` | Monitor subagents: timeline stream toggle, list, per-agent transcript |
| `/director` | `packages/cli/src/slash-commands/spawn-agents.ts` | Promote to director mode |
| `/delegate` | `packages/cli/src/slash-commands/delegate.ts` | Hand a task to a specialist subagent; `/delegate list` for roles |
| `/fleet` | `packages/cli/src/slash-commands/fleet.ts` | Fleet status, usage, kill, manifest, retry, log, stream |
| `/sdd` | `packages/cli/src/slash-commands/sdd.ts` | Spec-driven development workflow |
| `/btw` | `packages/cli/src/slash-commands/btw.ts` | Quick side-note workflow |
| `/next` | `packages/cli/src/slash-commands/next.ts` | Toggle next-task prediction |
| `/suggest` | `packages/cli/src/slash-commands/suggest.ts` | Generate context-aware next-step suggestions; `/suggest --fast` for heuristics |
| `/enhance` | `packages/cli/src/slash-commands/enhance.ts` | Toggle prompt refinement ("did you mean this?") before sending |
| `/ensemble` | `packages/cli/src/slash-commands/ensemble.ts` | Fan a task out to multiple ACP-supporting agents in parallel (claude-code, gemini-cli, codex-cli, etc.) |
| `/fix` | `packages/cli/src/slash-commands/fix.ts` | Classify and route a bug/error fix |
| `/autophase` | `packages/cli/src/slash-commands/autophase.ts` | Autonomous phase-based workflow |
| `/worktree` | `packages/cli/src/slash-commands/worktree.ts` | Inspect and manage worktrees used by AutoPhase |
| `/settings` | `packages/cli/src/slash-commands/settings.ts` | View or change runtime settings |
| `/telegram-setup` | `packages/cli/src/slash-commands/telegram-setup.ts` | Configure Telegram bot token and default chat; `/tg-setup` alias |
| `/collab` | `packages/cli/src/slash-commands/collab.ts` | Live collaboration helpers |
| `/statusline` | `packages/cli/src/slash-commands/statusline.ts` | Toggle TUI status bar items; `/sl` alias |
| `/interrupt` | `packages/cli/src/slash-commands/interrupt.ts` | Abort the in-flight leader iteration |
| `/brain` | `packages/cli/src/slash-commands/brain.ts` | View and configure Brain risk arbiter; `/brain ask <q>`, `/brain risk <level>` |
| `/coordinator` | `packages/cli/src/slash-commands/coordinator.ts` | Start/stop the AutonomousCoordinator for multi-session goal tracking; see `docs/slash/coordinator.md` and `docs/autonomous-coordinator.md` |
| `/review` | `packages/cli/src/slash-commands/review.ts` | Run a review pass (LLM-driven code review) |
| `/mailbox` | `packages/cli/src/slash-commands/mailbox.ts` | Inter-agent mailbox inspection and messaging |
| `/mailbox-demo` | `packages/cli/src/slash-commands/mailbox-demo.ts` | Demo mailbox routing for development |
| `/mailbox-serve` | `packages/cli/src/slash-commands/mailbox-serve.ts` | Start the mailbox HTTP bridge for external agents |
| `/fallback` | `packages/cli/src/slash-commands/fallback.ts` | Configure fallback model behavior |
| `/working_dir` | `packages/cli/src/slash-commands/working-dir.ts` | Show or change the working directory; `/wd`, `/cd` aliases |
| `/project` | `packages/cli/src/slash-commands/project.ts` | Project picker and registry (list, add, rename, remove, switch) |
| `/mouse` | `packages/cli/src/slash-commands/mouse.ts` | Mouse event capture for UI testing |
| `/telegram-settings` | `packages/cli/src/slash-commands/telegram-settings.ts` | Configure Telegram notification preferences |
| `/audit` | `packages/cli/src/slash-commands/audit.ts` | Side-effect audit trail (bash, install, fetch); `/sideeffects`, `/side` aliases |
| `/f` | `packages/cli/src/slash-commands/f-keys.ts` | Open F-key panels by number (`/f 1`–`/f 12`, `/f1`–`/f12`) |
| `/shadow` | `packages/cli/src/slash-commands/shadow.ts` | Start, manage, and stop the Shadow Agent fleet monitor |
| `/security` | `packages/cli/src/slash-commands/security.ts` | Security diagnostics: audit-deps, scan dispatch, redact-test |

## Built-in plugin commands

These commands are enabled by default when plugins are enabled and their host dependencies are available.

| Command | Source | What it does |
|---|---|---|
| `/prompts` | `packages/core/src/plugins/prompts-plugin.ts` | Manage the prompt library (list/view/add/edit/delete/favorite/extend) |
| `/prompt` | `packages/core/src/plugins/prompts-plugin.ts` | Search the merged library (builtin + user + project) and insert a prompt |
| `/prompt-gen` | `packages/core/src/plugins/prompts-plugin.ts` | LLM-guided prompt authoring |
| `/sync` | `packages/core/src/plugins/sync-plugin.ts` | GitHub-backed sync for prompts, skills, settings, memory, and history |
| `/commit` | `packages/core/src/plugins/git-plugin.ts` | Stage all changes and commit with an auto-generated message; `/gc` alias |
| `/gitcheck` | `packages/core/src/plugins/git-plugin.ts` | Silent uncommitted-change check; `/gcstatus` alias |
| `/push` | `packages/core/src/plugins/git-plugin.ts` | Push current branch to configured remotes |
| `/metrics` | `packages/core/src/plugins/observability-plugin.ts` | Metrics snapshot; requires `--metrics` |
| `/health` | `packages/core/src/plugins/observability-plugin.ts` | Run health checks; requires `--metrics` |
| `/skill` | `packages/core/src/plugins/skills-plugin.ts` | List skills or show a skill body |
| `/skill-gen` | `packages/core/src/plugins/skills-plugin.ts` | LLM-guided skill authoring |
| `/skill-install` | `packages/core/src/plugins/skills-plugin.ts` | Install skills from GitHub |
| `/skill-update` | `packages/core/src/plugins/skills-plugin.ts` | Update installed skills |
| `/skill-uninstall` | `packages/core/src/plugins/skills-plugin.ts` | Remove installed skills |
| `/plan` | `packages/core/src/plugins/plan-plugin.ts` | Strategic plan board |

Optional built-in plugins, such as the LSP and Telegram plugins, can also register slash commands when enabled.

## Dispatch flow

```text
REPL input "/<command> <args>"
  -> SlashCommandRegistry.dispatch(name, args, ctx)
  -> matching SlashCommand.run(args, ctx)
  -> returns { message?: string, runText?: string, exit?: boolean }
```

`runText` is a special field: when a slash command returns it, the REPL injects that text into the next agent turn. `/goal`, `/sdd`, `/autonomy`, `/fix`, `/skill-gen`, `/prompt-gen`, and `/prompt insert` use this to steer the AI conversation without the user typing the full prompt.

## Adding a core slash command

### Checklist

1. **Create** `packages/cli/src/slash-commands/<name>.ts`.
2. **Define** `buildXxxCommand(opts: SlashCommandContext): SlashCommand` — return
   an object with `name`, `category`, `description`, `help`, and `run`.
3. **Register** — import and add to `buildBuiltinSlashCommands()` in
   `packages/cli/src/slash-commands/index.ts`.
4. **Test** — add tests under `packages/cli/tests/` using vitest.
5. **Document** — add or update docs under `docs/slash/` and the README table.

### SlashCommand shape

```typescript
interface SlashCommand {
  name: string;           // e.g. 'delegate' — becomes /delegate
  category?: 'Run' | 'Session' | 'Inspect' | 'Agent' | 'Config' | 'App';
  aliases?: string[];     // e.g. ['del', 'dlg']
  description: string;    // one-line shown in /help listing
  argsHint?: string;      // e.g. '[--role=<role>] <task>'
  help?: string;          // detailed help shown by /help <name>
  run(args: string, ctx: Context): Promise<{ message?: string; runText?: string; exit?: boolean }>;
}
```

### Minimal example (from `/delegate`)

```typescript
// packages/cli/src/slash-commands/mycommand.ts
import { color } from '@wrongstack/core';
import type { SlashCommand } from '@wrongstack/core';
import type { SlashCommandContext } from './index.js';
import { parseSubcommand, unknownSubcommand } from './helpers.js';

export function buildMyCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'mycommand',
    category: 'Agent',
    description: 'What /mycommand does in one line.',
    argsHint: '[sub] [args]',
    help: [
      'Usage:',
      '  /mycommand           Show status',
      '  /mycommand sub1      Do thing one',
      '  /mycommand sub2      Do thing two',
    ].join('\n'),

    async run(args) {
      const { cmd, rest } = parseSubcommand(args);

      switch (cmd) {
        case '':
        case 'status':
          return { message: 'Status: all good.' };
        case 'sub1':
          return handleSub1(rest);
        default:
          return {
            message: unknownSubcommand(cmd, ['sub1', 'sub2'], 'mycommand'),
          };
      }
    },
  };
}
```

### Registration

```typescript
// packages/cli/src/slash-commands/index.ts
import { buildMyCommand } from './mycommand.js';
// ...inside buildBuiltinSlashCommands():
buildMyCommand(opts),
```

### Testing

```typescript
// packages/cli/tests/slash-mycommand.test.ts
import { describe, expect, it, vi } from 'vitest';
import { buildMyCommand } from '../src/slash-commands/mycommand.js';

function ctx(extra = {}) {
  return {
    session: { id: 's1' },
    renderer: { write: () => {}, writeWarning: () => {} },
    projectRoot: '/tmp',
    cwd: '/tmp',
    ...extra,
  } as never;
}

describe('buildMyCommand', () => {
  it('shows usage when no args', async () => {
    const cmd = buildMyCommand(ctx());
    const res = await cmd.run('');
    expect(res?.message).toContain('Status');
  });
});
```

### Key imports

| Import | From | Purpose |
|---|---|---|
| `color`, `noOpVault`, `dispatchAgent` | `@wrongstack/core` | Core utilities |
| `type SlashCommand` | `@wrongstack/core` | Return type |
| `type SlashCommandContext` | `./index.js` | DI context |
| `parseSubcommand`, `unknownSubcommand` | `./helpers.js` | Arg parsing + error messages |

### Category values

| Category | When to use |
|---|---|
| `Run` | Commands that execute something (`/dev`) |
| `Session` | Session lifecycle (`/clear`, `/compact`, `/save`, `/sessions`) |
| `Inspect` | Read-only inspection (`/context`, `/tools`, `/memory`, `/tasks`) |
| `Agent` | Multi-agent and AI steering (`/spawn`, `/fleet`, `/delegate`, `/fix`) |
| `Config` | Settings and configuration (`/mode`, `/settings`, `/models`) |
| `App` | Application-level (`/help`, `/exit`)

## Adding a plugin slash command

Register it from a plugin with `api.slashCommands.register(command)` and declare `capabilities: { slashCommands: true }`. First-party built-in plugins can claim bare command names; user plugins are namespaced by owner unless the host marks them official.
