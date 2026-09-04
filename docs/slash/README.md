# Slash Commands - Overview

WrongStack routes slash commands through `SlashCommandRegistry`. The command set is assembled from three independently registered surfaces: CLI core commands, commands mounted by the TUI, and plugin commands. The tables below are derived from the corresponding registration sites; aliases are shown explicitly rather than treated as separate commands.

## Always-registered CLI commands

`buildBuiltinSlashCommands()` in `packages/cli/src/slash-commands/index.ts` is the canonical registry for this table.

| Command | Aliases | Reference |
|---|---|---|
| `/help` | — | [help](help.md) |
| `/desktop` | — | [app surfaces](app-surfaces.md) |
| `/webui` | `/web` | [app surfaces](app-surfaces.md) |
| `/init` | — | [init](init.md) |
| `/clear` | — | [clear](clear.md) |
| `/interrupt` | `/stop`, `/int` | [interrupt](interrupt.md) |
| `/kanban` | `/kb`, `/board` | [kanban](kanban.md) |
| `/compact` | — | [compact](compact.md) |
| `/context` | `/ctx` | [context](context.md) |
| `/delegate` | — | [delegate](delegate.md) |
| `/dev` | — | [dev](dev.md) |
| `/doctor` | — | [doctor](doctor.md) |
| `/health` | — | [health](health.md) |
| `/metrics` | — | [metrics](metrics.md) |
| `/tuneup` | `/checkup` | [tuneup](tuneup.md) |
| `/codebase-reindex` | `/reindex` | [codebase reindex](codebase-reindex.md) |
| `/techstack` | `/tech`, `/deps` | [tech stack](techstack.md) |
| `/tool` | — | [tool modes](tool.md) |
| `/tools` | — | [tools](tools.md) |
| `/plugin` | `/plugins` | [plugin manager](plugin.md) |
| `/prune` | — | [prune](prune.md) |
| `/mcp` | `/mcp-servers` | [MCP](mcp.md) |
| `/suggest` | `/next-steps`, `/what-next` | [suggest](suggest.md) |
| `/auth` | — | [auth](auth.md) |
| `/diag`, `/stats` | — | [diagnostics and stats](diag-stats.md) |
| `/spawn`, `/agents` | — | [multi-agent commands](spawn-agents.md) |
| `/agent-improve` | — | [agent identity & learning](agent-improve.md) |
| `/fleet` | — | [fleet](fleet.md) |
| `/director` | — | Show fleet status (Director Mode is permanently on) |
| `/f` | hidden `/f1` … `/f12` commands | [F-key panels](f-keys.md) |
| `/enhance` | — | [enhance](enhance.md) |
| `/ensemble` | — | [ensemble](ensemble.md) |
| `/acp` | — | [ACP](acp.md) |
| `/memory` | — | [memory](memory.md) |
| `/todos` | — | [todos](todos.md) |
| `/plan` | — | [plan](plan.md) |
| `/tasks` | — | [tasks](tasks.md) |
| `/sdd` | — | [SDD](sdd.md) |
| `/save`, `/sessions`, `/exit` | `/resume`, `/load`; `/quit`, `/q` | [session management](session.md) |
| `/yolo` | — | [YOLO](yolo.md) |
| `/mouse` | — | [mouse](mouse.md) |
| `/autonomy` | — | [autonomy](autonomy.md) |
| `/goal-state` | — | [goal state](goal-state.md) |
| `/coordinator` | — | [coordinator](coordinator.md) |
| `/brain` | — | [Brain](brain.md) |
| `/btw` | — | [by-the-way messages](btw.md) |
| `/next` | `/enxt` | [next-task prediction](next.md) |
| `/mode` | — | [mode](mode.md) |
| `/design` | — | [design](design.md) |
| `/mailbox-demo` | — | [mailbox demo](mailbox-demo.md) |
| `/mailbox` | `/mb` | [mailbox](mailbox.md) |
| `/mailbox-serve` | — | [mailbox bridge](mailbox-serve.md) |
| `/fix` | — | [fix](fix.md) |
| `/goal` | — | [goal](goal.md) |
| `/worktree` | `/wt` | [worktrees](worktree.md) |
| `/settings` | — | [settings](settings.md) |
| `/hq` | — | [HQ connection](hq.md) |
| `/telegram-setup` | `/tg-setup` | [Telegram setup](telegram-setup.md) |
| `/telegram-settings` | `/tg-settings` | [Telegram settings](telegram-settings.md) |
| `/setmodel` | — | [model selection](setmodel.md) |
| `/refiner` | — | [goal refiner](refiner.md) |
| `/fallback` | — | [fallback models](fallback.md) |
| `/git`, `/commit`, `/gitcheck`, `/push` | `/gc`, `/gcstatus` | [Git commands](git.md) |
| `/gitid` | — | [Git identity](gitid.md) |
| `/modelcaps` | — | [model capabilities](modelcaps.md) |
| `/models` | — | [custom models](models.md) |
| `/collab` | — | [collaboration](collab.md) |
| `/review` | `/cr` | [review](review.md) |
| `/security` | — | [security](security.md) |
| `/project` | `/projects` | [project registry](project.md) |
| `/working_dir` | `/wd`, `/cd` | [working directory](working-dir.md) |
| `/statusline` | `/sl` | [status line](statusline.md) |
| `/shadow` | `/shadow-agent` | [Shadow Agent](shadow.md) |
| `/supervisor` | — | [supervisor](supervisor.md) |
| `/audit` | `/sideeffects`, `/side` | [side-effect audit](audit.md) |
| `/theme` | — | Switch or select the TUI color theme preset interactively |
| `/tier` | — | View or change model cost tiers (budget/standard/premium) and their routing |
| `/effort` | — | View or set the session-wide reasoning effort for the active model |
| `/profile` | — | Manage configuration profiles |
| `/sidebar` | — | Toggle or configure the TUI right sidebar visibility |
| `/intake` | — | Create and submit a requirement intake record from the current prompt |
| `/provider-status` | — | Live provider/model health: healthy, degraded, blocked |

`/f1` through `/f12` are twelve separately registered hidden commands, not entries in the `aliases` array.

## TUI-mounted commands and aliases

The TUI registers these commands after mounting. They are not available in the plain REPL unless another surface registers the same name.

| Command | Aliases | Behavior / reference |
|---|---|---|
| `/queue` | — | Manage pending mid-run messages; [queue](queue.md) |
| `/kill` | — | List or stop tracked shell processes; [process control](process-control.md) |
| `/ps` | — | Read-only tracked-process list; [process control](process-control.md) |
| `/steer` | — | Abort the current run and redirect it; [steer](steer.md) |
| `/rewind` | — | Open or directly use the checkpoint timeline; [rewind](rewind.md) |
| `/model` | `/provider`, `/switch` | Open the provider/model picker; [model picker](model.md) |
| `/settings-get` | `/config-get`, `/get` | Read settings without opening the picker; [settings lookup](settings-get.md) |
| `/lite`, `/full` | — | Layout presets: statusline density + sidebar visibility; [layout presets](lite-full.md) |
| `/connections` | `/conn`, `/conns` | Service connection health — Chronicle, Codebase Index, SAGE Memory, Kanban IPC, Mailbox IPC |
| `/flow` | `/workbench` | Text-first cross-board Kanban view: running, ready, blocked, awaiting review |
| `/solo` | — | Control session-only subagents before the first message: `/solo on\|off\|status` |
| `/cron` | — | Bare `/cron` opens the cron monitor; arguments fall through to the core handler |

The TUI also installs official overrides for existing names. `/settings` gains `/config` and `/prefs`; `/mailbox` gains `/inbox` and `/mail`; and `/autonomy` gains `/auto`. The core aliases remain registered, so `/mb` still reaches the core mailbox command. The TUI claims `/resume` and `/load` for its session picker while `/sessions` remains the core listing command. `/f`, `/design`, and `/statusline` keep their core names but gain interactive behavior.

## First-party plugin commands

First-party plugins are official registry owners, so an enabled plugin exposes both a bare name and its `owner:name` form. Default-active plugins load only when plugins and their required host dependencies are available. The opt-in rows below refer to plugins present in the built-in factory list but marked inactive by default in `PLUGIN_AUDIT_ENTRIES`.

| State | Plugin | Commands and aliases |
|---|---|---|
| Default active | `wstack-prompts` | `/prompts`, `/prompt`, `/prompt-gen`; [prompt library](prompts.md), [prompt search](prompt.md), [prompt generator](prompt-gen.md) |
| Default active | `wstack-sync` | `/sync`; [sync](sync.md) |
| Default active | `wstack-skills` | `/skill`, `/skill-gen`, `/skill-search`, `/skill-install`, `/skill-import`, `/skill-update`, `/skill-uninstall`; [skill commands](skills.md) |
| Opt-in | `wstack-chimera` | `/chimera`; [Chimera](chimera.md) |
| Opt-in | `wstack-auto-review` | `/auto-review`; [auto-review](auto-review.md) |
| Opt-in | `semver-bump` | `/semver`; [semantic versioning](semver.md) |
| Opt-in | `@wrongstack/plug-lsp` | `/lsp` (`/lsplsp`), plus `/list`, `/start`, `/stop`, `/restart`, `/diagnostics`; [LSP](lsp.md) |
| Opt-in | `telegram` | `/telegram-health` (`/telegram`, `/tgstat`, `/tgs`), `/send`, `/chatid`; [Telegram plugin](telegram.md) |

Plugin registration is last-write-wins for bare official names. In particular, enabling the LSP plugin makes bare `/stop` the LSP stop command instead of the core alias for `/interrupt`; `/interrupt` and `/int` remain unambiguous. Namespaced forms such as `/@wrongstack/plug-lsp:stop` and `/telegram:send` are always available while their plugin is loaded. External plugins do not receive bare names and are invoked only as `/owner:command`.

## Dispatch flow

```text
REPL input "/<command> <args>"
  -> SlashCommandRegistry.dispatch(name, args, ctx)
  -> matching SlashCommand.run(args, ctx)
  -> returns { message?: string, runText?: string, exit?: boolean }
```

`runText` is a special field: when a slash command returns it, the REPL injects that text into the next agent turn. `/goal start`, `/goal-state`, `/sdd`, `/autonomy`, `/fix`, `/skill-gen`, `/prompt-gen`, and `/prompt insert` use this to steer the AI conversation without the user typing the full prompt.

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
