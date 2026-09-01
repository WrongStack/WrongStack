# AGENTS.md

> **DO NOT DELETE THIS FILE.** It is loaded into WrongStack's system prompt as
> persistent project context. The `/init` command **regenerates** this file from
> detected project facts and backs up any previous version to `AGENTS.md.bak`.
> After `/init`, review the backup and merge any hand-written project context
> back into this file — then add your conventions, architecture notes, and
> domain knowledge below.

## Project brief

- **Purpose:** WrongStack is an AI coding agent platform — a CLI/TUI/WebUI that
  lets developers delegate coding tasks to LLM-powered agents. It supports
  multi-agent orchestration (fleet), inter-agent coordination (mailbox),
  plugins, MCP servers, ACP (Agent Communication Protocol) for external agent
  integration, and a React-based WebUI.
- **Primary users:** Developers using the terminal (CLI/TUI), operators using
  the HQ dashboard, and downstream integrators embedding WrongStack.
- **Runtime / deployment:** Monorepo — `packages/` for libraries + CLI + TUI,
  `website/` for the marketing/docs site (Vite + React 19 + Tailwind v4).

> Auto-detected: package.json scripts, typescript, .github/workflows

## How to work safely

- **Never commit code you didn't write.** The working tree is shared across
  multiple agents (CLI sessions, TUI sessions, WebUI). Use `git status` before
  committing and scope commits to files you changed.
- **Changes in `packages/core/` affect every downstream package.** Run the
  full test suite (`pnpm test`) after core changes. The `--filter` flag in
  pnpm limits blast radius during development.
- **Website pages source from `packages/core/src/` source files.** When
  enriching a website page, read the referenced source file first — never
  fabricate content.
- **Biome is the sole formatter + linter.** Prettier and ESLint are not
  configured. Run `pnpm run format` and `pnpm run lint` before committing.
- **TypeScript strict mode is enforced** across all packages. `pnpm run
  typecheck` runs across the entire monorepo.
- **The `.wrongstack/` directory** at the project root contains the shared
  mailbox, memory store, knowledge graph, and installed skills. It is
  gitignored — each developer maintains their own.

## Performance contract

Applies to every performance-motivated change. Canonical text lives in
`CONTRIBUTING.md` (committed — this file is not); design in
`docs/performance-ratchet.md`.

- **No performance claim without a number** — show the before/after and the
  exact command that produced it.
- **Baseline first**, into `PERF_LOG.md`: workload, command, metric, value,
  commit, machine, runtime version.
- **One variable at a time.** If the delta is inside noise — below the spread of
  3 repeat runs, or under 5% — **revert it**. This is enforced by `decide()` in
  `@wrongstack/core/performance`, not left to judgement.
- **Correctness gates everything.** A faster wrong answer is a regression.
- **Order of attack:** do less work → do it fewer times → do it later or never →
  only then make the same work faster. Never start at micro-optimisation.
- Label every statement **measured**, **read in the code**, or **SPECULATIVE**.

Tools: `/perf` (round), `/perf log` (ledger, no model call), `pnpm perf:guard`.

## Commands

| Command | Script |
|---------|--------|
| Build | `pnpm run build` |
| Test | `pnpm test` |
| Lint | `pnpm run lint` |
| Typecheck | `pnpm run typecheck` |
| Format | `pnpm run format` |
| Perf gate | `pnpm perf:guard` (needs `pnpm build` first — it measures `dist/`) |
| Run locally | `pnpm --filter @wrongstack/cli exec wstack` |

## Key files and entry points

| File / directory | Role |
|---|---|
| `packages/core/` | Shared types, coordination (mailbox, fleet, collab), rendering, token counting |
| `packages/cli/` | CLI entry point, slash commands, subcommands, REPL |
| `packages/tui/` | Terminal UI (React + Ink) — multi-panel interface |
| `packages/acp/` | Agent Communication Protocol v1 — client + server |
| `packages/mcp/` | MCP (Model Context Protocol) transport layer |
| `packages/plug-lsp/` | LSP plugin for WrongStack |
| `packages/tools/` | Built-in tool implementations (available to agents) |
| `packages/webui/` | Next.js app — the browser-based UI |
| `website/` | Marketing + documentation site (Vite, React 19, Tailwind v4) |
| `docs/` | Architecture docs, ACP spec, plugin author guide |
| `scripts/` | Build, release, lint, bench automation scripts |
| `.github/workflows/ci.yml` | CI: lint, typecheck, test on push/PR |

## Architecture notes

WrongStack is a TypeScript monorepo managed by pnpm workspaces. The
`packages/core` library has zero runtime dependencies and is the foundation
every other package builds on. The CLI assembles everything above core — slash
commands, subcommands, REPL, and the agent runtime.

### Dependency layers

```
core (no runtime deps)
 ├── cli (REPL, slash commands, subcommands)
 ├── tui (React + Ink terminal UI)
 ├── acp (external agent protocol)
 ├── mcp (model context protocol)
 ├── plug-lsp (LSP integration)
 ├── tools (built-in tool implementations)
 └── webui (Next.js browser UI)
```

`core` must never depend on downstream packages. The `tools` package registers
tool implementations that agents invoke — it depends on `core` for the tool
contract types.

### Extension points

- **Plugins** — loaded from `~/.wrongstack/plugins/`, implement a
  `PluginCapabilities` interface with optional `llm`, `tools`, `skills`, and
  `commands` capabilities.
- **MCP servers** — stdio or HTTP transports, registered via `/mcp` slash
  commands or the MCP plugin.
- **Slash commands** — built-in commands live in
  `packages/cli/src/slash-commands/`. Plugins can register additional ones.
- **ACP** — WrongStack is both client and server. As a client, it drives
  Claude Code, Gemini CLI, and 10+ other external agents. As a server,
  external editors (Zed, JetBrains) can drive WrongStack tools.

## Domain knowledge

- **Package manager is pnpm 11.5.3** — workspace protocol (`workspace:*`) is
  used for inter-package dependencies. Lockfile is `pnpm-lock.yaml`.
- **Node.js >= 22.19.0** required. `engines` field is enforced.
- **Versioning** is manual via `scripts/bump-version.mjs`. Current version is
  read from root `package.json` `version` field and synced to all packages.
- **AGENTS.md** at `.wrongstack/AGENTS.md` is not committed to git — it's
  developer-local context for the system prompt. The `/init` command
  regenerates it.
- **Git worktrees** are used by AutoPhase for isolated agent execution.
  `.wrongstack/worktrees/` contains per-phase checkouts.
- **The mailbox** is a JSONL file at
  `~/.wrongstack/projects/<slug>/_mailbox.jsonl` with file-locking. All
  agent coordination flows through it.
- **Website pages** map to `website/src/pages/` and use a consistent
  component pattern: `PageHero`, `SectionIntro`, feature cards with Lucide
  icons, and `ExternalDoc`/`PageNext` primitives.

## Verification checklist

- **After code changes:** `pnpm test` (or scoped: `pnpm --filter
  @wrongstack/core test`)
- **After type changes:** `pnpm run typecheck`
- **After UI changes:** `pnpm run lint` + `pnpm run format`
- **Before release:** `pnpm run release:check` (runs audit, build, contract
  checks, node-pty, i18n, typecheck, and full test suite)
- **Website smoke test:** `pnpm --filter website exec vite build` — confirms
  the production bundle compiles without errors
- **Flaky tests:** The MCP soak tests (`fault-soak.test.ts`) are timing-
  sensitive and may fail under CI resource pressure — rerun isolated if needed
- **Cross-agent conflict:** Check `git status` and mailbox before committing
  in the shared working tree

## Useful pointers

- Architecture deep-dive: `ARCHITECTURE.md`
- Security model: `SECURITY.md`
- Plugin authoring: `docs/plugin-author-guide.md`
- ACP + Ensemble: `docs/acp-ensemble.md`
- YOLO mode: `docs/yolo-mode.md`
- Agent roster roles: `docs/agent-roster/`
- Website dev server: `pnpm --filter website exec vite`
