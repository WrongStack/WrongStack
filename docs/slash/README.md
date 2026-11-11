# Slash Commands - Overview

WrongStack routes slash commands through `SlashCommandRegistry`. The command set is assembled from three independently registered surfaces: CLI core commands, commands mounted by the TUI, and plugin commands. The tables below are derived from the corresponding registration sites; aliases are shown explicitly rather than treated as separate commands.

## CLI command registrations

`buildBuiltinSlashCommands()` in `packages/cli/src/slash-commands/index.ts` is the canonical registry for this table.

The registry includes conditional host capabilities: `/provider-status` requires
the host's status tracker. TUI-only overrides and plugin commands are listed
separately below.

| Command | Aliases | Reference |
|---|---|---|
| `/help` | — | [help](help.md) |
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
| `/codebase-map` | — | [codebase map](codebase-map.md) |
| `/techstack` | `/tech`, `/deps` | [tech stack](techstack.md) |
| `/tool` | — | [tool modes](tool.md) |
| `/tools` | — | [tools](tools.md) |
| `/plugin` | `/plugins` | [plugin manager](plugin.md) |
| `/panel` | — | [plugin panels](panel.md) |
| `/prune` | — | [prune](prune.md) |
| `/mcp` | `/mcp-servers` | [MCP](mcp.md) |
| `/browser` | `/network` | [Browser setup and local origins](browser.md) |
| `/suggest` | `/next-steps`, `/what-next` | [suggest](suggest.md) |
| `/auth` | — | [auth](auth.md) |
| `/diag`, `/stats` | — | [diagnostics and stats](diag-stats.md) |
| `/spawn`, `/agents` | — | [multi-agent commands](spawn-agents.md) |
| `/agent-improve` | — | [agent identity & learning](agent-improve.md) |
| `/fleet` | — | [fleet](fleet.md) |
| `/director` | — | [Fleet status](fleet.md); Director is permanently available |
| `/scout-stats` | — | [Scout statistics](scout-stats.md) |
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
| `/tree` | — | [session tree](tree.md) |
| `/image` | — | [inline image preview](image.md) |
| `/yolo` | — | [YOLO](yolo.md) |
| `/mouse` | — | [mouse](mouse.md) |
| `/autonomy` | — | [autonomy](autonomy.md) |
| `/coordinator` | — | [coordinator](coordinator.md) |
| `/brain` | — | [Brain](brain.md) |
| `/btw` | — | [by-the-way messages](btw.md) |
| `/next` | `/enxt` | [next-task prediction](next.md) |
| `/nextsteps` | — | [required next steps + auto-continue limit](nextsteps.md) |
| `/mode` | — | [mode](mode.md) |
| `/design` | — | [design](design.md) |
| `/mailbox-demo` | — | [mailbox demo](mailbox-demo.md) |
| `/mailbox` | `/mb` | [mailbox](mailbox.md) |
| `/mailbox-serve` | — | [mailbox bridge](mailbox-serve.md) |
| `/fix` | — | [fix](fix.md) |
| `/goal` | — | [goal](goal.md) |
| `/goals` | — | [Project goal catalog](goals.md) |
| `/jev` | `/typesafe` | [Jev account and controls](jev.md) |
| `/permissions` | — | [Policy inspection and session rules](permissions.md) |
| `/sandbox` | — | [Sandbox policy](sandbox.md) |
| `/worktree` | `/wt` | [worktrees](worktree.md) |
| `/settings` | — | [settings](settings.md) |
| `/hq` | — | [HQ connection](hq.md) |
| `/telegram-setup` | `/tg-setup` | [Telegram setup](telegram-setup.md) |
| `/telegram-settings` | `/tg-settings` | [Telegram settings](telegram-settings.md) |
| `/setmodel` | — | [model selection](setmodel.md) |
| `/subagent-models` | — | [subagent model lanes](subagent-models.md) |
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
| `/theme` | — | [TUI theme presets](theme.md) |
| `/tier` | — | [Tier routing, budgets and leader policy](tier.md) |
| `/effort` | — | [Reasoning effort and supported levels](effort.md) |
| `/profile` | — | [Configuration profiles](profile.md) |
| `/sidebar` | — | [TUI sidebar visibility](sidebar.md) |
| `/intake` | — | [Requirement intake](intake.md) |
| `/provider-status` | — | [Provider/model health](provider-status.md) |
| `/openai-quota` | — | [openai-quota](openai-quota.md) — ChatGPT (Codex) plan windows used and reset times |
| `/provider-quota` | — | [provider-quota](provider-quota.md) — Plan windows used and reset times for every metered provider |
| `/zai-plan` | — | [zai-plan](zai-plan.md) — Z.AI / BigModel GLM Coding Plan: subscription, 5h/weekly windows, MCP pool, usage |

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
| `/connections` | `/conn`, `/conns` | [Service health and restart](connections.md) |
| `/flow` | `/workbench` | [Cross-board focus lanes](flow.md) |
| `/solo` | — | [Session worker policy](solo.md), including companions mode |
| `/cron` | — | [Session cron monitor](cron.md); arguments use the registered list handler |

The TUI also installs official overrides for existing names. `/settings` gains `/config` and `/prefs`; `/mailbox` gains `/inbox` and `/mail`; and `/autonomy` gains `/auto`. The core aliases remain registered, so `/mb` still reaches the core mailbox command. The TUI claims `/resume` and `/load` for its session picker while `/sessions` remains the core listing command. `/f`, `/design`, and `/statusline` keep their core names but gain interactive behavior.

## First-party plugin commands

First-party plugins are official registry owners, so an enabled plugin exposes both a bare name and its `owner:name` form. Default-active plugins load only when plugins and their required host dependencies are available. The opt-in rows below refer to plugins present in the built-in factory list but marked inactive by default in `PLUGIN_AUDIT_ENTRIES`.

| State | Plugin | Commands and aliases |
|---|---|---|
| Default active | `wstack-prompts` | `/prompts`, `/prompt`, `/prompt-gen`, `/bughunt`, `/perf`, `/sechunt` (`/secproof`), `/racehunt` (`/leakhunt`, `/flakehunt`), `/debloat` (`/deadcode`, `/excise`), `/uipolish` (`/a11yhunt`, `/uihunt`), `/typehunt` (`/boundaryhunt`), `/testgap` (`/covhunt`, `/invarianthunt`); [prompt library](prompts.md), [prompt search](prompt.md), [prompt generator](prompt-gen.md) |
| Default active | `wstack-sync` | `/sync`; [sync](sync.md) |
| Default active | `wstack-skills` | `/skill`, `/skill-gen`, `/skill-search`, `/skill-install`, `/skill-import`, `/skill-update`, `/skill-uninstall`; [skill commands](skills.md) |
| Default active | `wstack-chimera` | `/chimera`; [Chimera](chimera.md) |
| Default active | `wstack-auto-review` | `/auto-review`; [auto-review](auto-review.md) |
| Opt-in | `wstack-specialist-triggers` | `/specialist-triggers`; [specialist triggers](specialist-triggers.md) |
| Opt-in | `semver-bump` | `/semver`; [semantic versioning](semver.md) |
| Opt-in | `@wrongstack/plug-lsp` | `/lsp` (`/lsplsp`), plus `/lsp-list`, `/lsp-start`, `/lsp-restart`, `/lsp-diagnostics`; namespaced `:lsp-stop`; [LSP](lsp.md) |
| Opt-in | `telegram` | `/telegram-health` (`/telegram`, `/tgstat`, `/tgs`), `/send`, `/chatid`; [Telegram plugin](telegram.md) |

Plugin registration is last-write-wins for bare official names. A plugin can keep a compatibility command namespaced-only when its short name belongs to the core interaction model: plug-lsp does this for `/@wrongstack/plug-lsp:lsp-stop`, while `/lsp stop` is its primary form and bare `/stop` remains the core alias for `/interrupt`. Namespaced forms such as `/@wrongstack/plug-lsp:lsp-stop` and `/telegram:send` are available while their plugin is loaded. External plugins do not receive bare names and are invoked only as `/owner:command`.

## Dispatch flow

```text
REPL input "/<command> <args>"
  -> SlashCommandRegistry.dispatch(name, args, ctx)
  -> matching SlashCommand.run(args, ctx)
  -> returns { message?: string, runText?: string, exit?: boolean }
```

`runText` is a special field: when a slash command returns it, the REPL injects that text into the next agent turn. `/goal set`, `/sdd`, `/autonomy`, `/fix`, `/skill-gen`, `/prompt-gen`, and `/prompt insert` use this to steer the AI conversation without the user typing the full prompt.

## Engine command bridge (WebUI and Desktop v2)

Since 1.5.0 the commands that need no terminal live in `@wrongstack/runtime/commands`, and both engine hosts (the CLI's WebUI host and the standalone engine Desktop v2 runs) serve them over the WebUI protocol: `command.list` answers with `command.catalog` (name, aliases, description, arguments, and whether the command changes or deletes data) and `command.run` with `command.result`. Hosts advertise this as the `command.bridge` capability. The CLI files re-export the moved commands, so the TUI runs the same code.

The bridge serves `/sandbox`, `/prune`, `/scout-stats`, `/init`, `/git`, `/commit`, `/gitcheck`, `/push`, `/gitid`, `/security`, `/spawn`, `/delegate`, `/director`, `/supervisor`, `/acp`, `/ensemble`, `/tuneup`, `/tree`, `/panel` and `/image`, then the builtin plugins' commands (the skill library, the prompt library, `/perf` and `/sync`); a portable command keeps a shared name. The plugins are set up only to collect their slash commands: none of their tools, hooks or event handlers start in the engine. Cloud config sync and specialist triggers stay with the TUI, as do `/coordinator` and `/shadow`.

- **WebUI chat.** A slash command the WebUI does not route itself runs on the engine when the catalog lists it, instead of going to the model, and its output is written into the chat. The slash picker and `/help` list the engine's commands after the WebUI's own.
- **Desktop composer.** Engine commands complete and run after the desktop's own commands; a desktop command of the same name wins.
- **Confirmation.** A command that changes or deletes data (for example `/push`, `/commit`, skill install or `/sync`) says what it will do first: the WebUI asks through its confirm dialog, and the desktop runs it when the same draft is sent again. `--dry-run` runs at once.
- **Follow-up turns.** A command's `runText` is sent as the next turn: through the desktop composer, or as the user's message in the WebUI.
- **Engine differences.** On an engine `/acp` and `/ensemble` run the external agent as a fleet subagent, as `--bg` does, and the agents view shows its progress. The standalone engine's `/tuneup` reports without the CLI's version check, config doctor and config history, writes fixes to its profile config with the same backups, and refuses `--pick`.

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
import { color } from '@wrongstack/core/utils';
import type { SlashCommand } from '@wrongstack/contracts/types';
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
| `color`, `noOpVault`, `dispatchAgent` | `@wrongstack/core/utils` | Core utilities |
| `type SlashCommand` | `@wrongstack/contracts/types` | Return type |
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
