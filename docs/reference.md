# WrongStack Reference

Condensed reference for the pieces that are too long to live in the README.
Use this as a map; the deep docs it links to are authoritative.

- [CLI flags, subcommands, and `wstack update`](cli-reference.md)
- [Slash commands](slash/)
- [Subcommands](subcommands/)
- [Configuration](configuration.md)
- [OAuth subscription sign-in](oauth-signin.md)
- [Architecture](architecture.md)
- [Skills](skills.md)
- [Agents / roster](agents.md)

---

## Built-in tools (61)

WrongStack ships **61 built-in tools** — no plugins required. They fall into
these families:

| Family | Examples |
|--------|----------|
| Filesystem | `read`, `write`, `edit`, `patch`, `replace`, `glob`, `grep`, `tree`, `diff` |
| Code quality | `lint`, `format`, `typecheck`, `test`, `language`, `language_package` |
| Execution | `bash`, `exec` |
| Search & web | `search`, `fetch` |
| Project insight | `codebase-index` (SQLite/FTS5 symbol index), `codebase-search`, `codebase-stats`, `dead-code-scan` |
| Planning | `todo`, `plan`, `task`, `kanban` |
| Git | `git`, `git_autocommit`, `semver_bump`, `semver_changelog` |
| Packages | `install`, `audit`, `outdated` |
| Browser / E2E | `browser_open`, `browser_navigate`, `browser_click`, `browser_screenshot`, `browser_evaluate`, … |
| Memory | `remember`, `memory_search`, `pin_add` |
| Agents | `delegate`, `spawn_subagent`, `assign_task`, `await_tasks` |
| Meta | `tool_search`, `tool_help`, `batch_tool_use`, `context_manager` |

Run `wstack tools` for the live, version-specific list.

---

## Providers (~140)

The catalog is fetched from [models.dev](https://models.dev) at boot and cached.
It covers four API-key wire families plus subscription sign-in:

- **API-key families:** Anthropic, OpenAI, Google, and ~125 OpenAI-compatible endpoints.
- **Subscription sign-in (OAuth):** ChatGPT (Codex), Claude Pro/Max, and GitHub Copilot — usable *alongside* API keys.

Browse with `wstack models` (paginated) or switch at runtime with `/model` in a
session. See [OAuth sign-in](oauth-signin.md) for subscription auth.

---

## Slash commands

Typed inside a running session (REPL / TUI / WebUI). Highlights:

- **Goal & autonomy:** `/goal`, `/sdd`
- **Git:** `/commit`, `/push`, `/sync`, `/gitcheck`
- **Quality:** `/security`, `/chimera`, `/metrics`, `/health`
- **Skills:** `/skill`, `/skill-gen`, `/skill-search`, `/skill-install`, `/skill-import`, `/skill-update`, `/skill-uninstall`
- **Prompts:** `/prompts`, `/prompt`, `/prompt-gen`
- **Runtime:** `/model`, `/plan`, `/context`, `/memory`

See [`docs/slash/`](slash/) for the complete reference for every command.

---

## Modes (19 personas)

WrongStack ships nineteen interaction modes (personas) that reshape tone,
verbosity, and defaults — e.g. Teach, Brief, Code Reviewer, plus token-saving
"*-lite" variants of review, audit, plan, debug, test, refactor, and research,
and "*-Deep" variants of review, audit, architecture, debug, test, devops,
refactor, ui-design, teach, and research. Switch modes at runtime; an active
mode prompt overrides conflicting baseline defaults.

---

## Bundled skills (29)

Skills are auto-activating capability packs matched on their trigger sentence.
The bundle covers API design, testing, security scanning, refactor planning,
git flow, TypeScript strict mode, modern Node/React, and more. See
[skills](skills.md) for the catalog and [skill authoring](skills.md#writing-effective-skills)
via the `skill-creator` skill.
