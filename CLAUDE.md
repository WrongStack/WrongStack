# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Canonical developer reference

`AGENTS.md` at the repo root is the canonical, in-depth dev reference (package map, kernel primitives, agent lifecycle, tool contract, multi-agent, MCP, compactors, plugins, session storage, slash command wiring, skill system, verification checklist). Read it before touching anything non-trivial — this file is the short version. `ARCHITECTURE.md` has the deep-dive architecture scan.

## Commands

Monorepo is pnpm + Node ≥ 22. All commands run from the repo root.

| Task | Command |
|---|---|
| Install | `pnpm install` |
| Build all packages | `pnpm run build` |
| Run all tests | `pnpm test` (vitest, 3300+ tests across all packages) |
| Watch tests | `pnpm run test:watch` |
| Single test file | `pnpm vitest run path/to/file.test.ts` |
| Single test by name | `pnpm vitest run -t "test name pattern"` |
| Typecheck (parallel across packages) | `pnpm run typecheck` |
| Lint | `pnpm run lint` (Biome) |
| Format | `pnpm run format` (Biome) |
| Coverage | `pnpm run test:coverage` |
| Benchmarks | `pnpm run bench` |
| Pre-release gate | `pnpm run release:check` (typecheck + test + build) |

Per-package work: `pnpm --filter @wrongstack/core test` (or `build`/`typecheck`). Dev launchers: `dev.sh` / `dev.ps1` at repo root.

## Architecture in one screen

**Monorepo layout** (`packages/*`, `apps/*`):

```
apps/wrongstack/          — bin entry (wrongstack / wstack)
packages/core/            — Kernel + agent loop + all default impls (no other ws deps)
packages/providers/       — Anthropic / OpenAI / Google / OpenAI-compatible adapters
packages/tools/           — Builtin tools (read, write, bash, grep, glob, git, ...)
packages/mcp/             — MCP client + registry (stdio / sse / streamable-http)
packages/plug-lsp/        — LSP bridge (/lsp:* slash commands)
packages/runtime/         — Default wiring: makeDefaultRuntime()
packages/cli/             — REPL, argv parsing, slash commands, plugin host
packages/tui/             — React/Ink TUI (lazy-loaded behind --tui)
packages/webui/           — Vite/React web UI (separate `webui` binary)
packages/telegram/        — Telegram bridge plugin
packages/skills/          — Skill packages
packages/bench/           — Model-independent benchmark harness (polyglot + SWE-bench) — see docs/subcommands/bench.md
```

**Dependency direction (do not reverse):**
`core` → nothing internal. `providers / tools / mcp / plug-lsp / runtime / telegram` → `core`. `cli / tui / webui` → everything beneath.

**Kernel primitives** (all in `packages/core/src/kernel/`, ~1670 LOC incl. event types):

- **Container** — typed DI keyed by `Token<T>` (branded symbol, *not* string). Bindings: `factory`/`value`/`decorator`, lazy + memoized. Well-known tokens in `tokens.ts`. Plugins rebind tokens before `Agent.run`.
- **Pipeline\<T\>** — linear middleware chain. Six pipelines fire per agent step: `userInput`, `request`, `response`, `assistantOutput`, `toolCall`, `contextWindow`. Middleware can `replace` a step — the last `replace` in the chain wins (position-aware).
- **EventBus** — typed pub/sub. Full event catalog in `kernel/events.ts` (`iteration.*`, `provider.*`, `tool.*`, `compaction.*`, `mcp.server.*`, `subagent.*`, `task.*`, `budget.*`).
- **RunController** — one per `Agent.run`, owns the `AbortController` chain and LIFO cleanup hooks.

**Agent loop** (`packages/core/src/agent.ts`): normalize user input → for each iteration: build request → provider call (with retry) → if tool_use blocks, batch-execute via `ToolExecutor` (permission check → tool → toolCall pipeline) → compact if needed → repeat. `autonomousContinue` parses `[continue]`/`[done]` markers for self-driving loops.

**Context / state** — `Context` is the live run object (messages, todos, system prompt, tools, provider, signal, cwd, model, meta) and implements `RunEnv`. Mutate via `ctx.state.appendMessage(m)` / `ctx.state.replaceMessages(ms)` so `onChange` subscribers fire.

**Tools** — implement `Tool<I, O>` with `inputSchema`, `permission` (`auto`/`confirm`/`deny`), `mutating`, `execute`, and optional `executeStream` (preferred — yields `log`/`partial_output`/`metric`/`file_changed`/`warning` then `{type:'final', output}`). The executor publishes each stream event as `tool.progress`.

**Multi-agent** — `DefaultMultiAgentCoordinator` runs a fleet with a task queue, `maxConcurrent` (default 4, configurable via `--max-concurrent`/`WRONGSTACK_MAX_CONCURRENT`/`/fleet concurrency`), per-subagent `SubagentBudget` (iterations/tool-calls/tokens/cost/timeout). Budgets self-extend through the `budget.threshold_reached` → onThreshold → `extend` event handshake. Enforcement on overrun has these cases: (1) no `onThreshold` handler / `'sync'` mode / no `EventBus` wired → `BudgetExceededError` thrown synchronously (nobody to negotiate with); (2) bus + a `budget.threshold_reached` listener → `BudgetThresholdSignal` thrown so the runner awaits the negotiated decision and enforces; (3) bus but no listener → the `onThreshold` handler is invoked synchronously: a **synchronous** policy/recording handler (the coordinator watchdog shape — returns a string/`{extend}` and/or calls the direct `extend`/`deny` hooks) is honored in place (an `extend` patches limits) with no throw, while an **async** handler (defers to `requestDecision()`, which can only resolve to `'stop'` with no listener) is a hard stop → `BudgetExceededError`. This keeps a bare `/spawn` (no director) protected from a runaway subagent while letting an in-process policy grant headroom without a wired listener. In production the coordinator always registers a listener, so case (2) is the live path; each exceeded kind negotiates independently and emits exactly one event for its own kind (dedup keyed per kind, cleared on a microtask).

**Autonomy / Goal** — `/goal <text>` persists to `<projectRoot>/.wrongstack/goal.json` (mission, journal, todos, goalState, todoAttempts). `/autonomy eternal` (or `--eternal`) runs the `EternalAutonomyEngine` (Sense → Decide → Execute → Reflect), driven by `buildGoalPreamble` + `makeAutonomyPromptContributor` (ephemeral system block, subagent-guarded). `[GOAL_COMPLETE]` marker flips goalState to `completed`.

**MCP** — JSON-RPC 2.0 over stdio / SSE / streamable-http. Tools get `mcp__<server>__<tool>` prefix. Reconnect uses exponential backoff + jitter, capped at 5 cycles → `failed`.

**Compaction** — `HybridCompactor` composes `SelectiveCompactor` + `IntelligentCompactor`; `AutoCompactionMiddleware` wraps the `contextWindow` pipeline (so compaction runs after every iteration, not explicitly in the agent loop). `repairToolUseAdjacency()` removes orphan `tool_use`/`tool_result` blocks after any context surgery.

**Sessions** — JSONL at `~/.wrongstack/projects/<hash>/sessions/<id>.jsonl` (hash = sha256(projectRoot)[:12]). Sidecar `<id>.summary.json` for fast listing. See `wstack-paths.ts` for the full layout.

**IDs are ULIDs**, not UUIDs.

## Slash commands

All builtins live in `packages/cli/src/slash-commands/`. Each exports `buildXxxCommand(opts: SlashCommandContext): SlashCommand` and is registered in `index.ts`'s `buildBuiltinSlashCommands()`. When a slash command returns `{ runText: "..." }`, the REPL injects that text as the next user turn — this is how `/goal`, `/sdd`, `/autonomy` steer the agent. Adding a new one: create file → register in `index.ts` → add tests at `packages/cli/tests/slash-<name>.test.ts` → add docs at `docs/slash/<name>.md`.

## Testing notes

- Vitest config: `vitest.config.ts` (unit), `vitest.bench.config.ts` (benchmarks)
- New slash commands → `packages/cli/tests/slash-<name>.test.ts`
- New tools → tests in the tool's package
- New kernel token → update `tokens.ts` and document in `AGENTS.md`
- New EventBus event → add to `events.ts` with doc comment

## Project conventions

- API keys in `~/.wrongstack/config.json` are encrypted with a per-machine key (`~/.wrongstack/.key`) via `DefaultSecretVault` — never write plaintext secrets. Optional at-rest hardening: set `WRONGSTACK_VAULT_PASSPHRASE` and the data key is stored passphrase-wrapped (scrypt KEK + AES-256-GCM, format v3) instead of in the clear — an existing key file auto-migrates on next load (same data key, so existing ciphertext still decrypts). Keep the passphrase: a wrapped key file cannot be unlocked without it.
- Per-machine config lives under `~/.wrongstack/`. A repo MAY also commit `<project>/.wrongstack/config.json` (the `inProjectConfig` layer), but it is an **untrusted, attacker-controllable** source: the config loader uses an **allow-list** in `stripUnsafeInProjectFields()` (`config-loader.ts`) — only a small set of benign preferences (`model`, `context`, `tools`, `features`, `autonomy`, `indexing`, `session`, `log`, `launch`, …) survive the merge; every other top-level field (`provider`/`apiKey`/`baseUrl`/`providers`/`mcpServers`/`hooks`/`plugins`/`sync`/`yolo`/`extensions`/`hq`) is stripped by default and surfaces in a `config.in_project_unsafe_fields_ignored` warning. The allow-list is paired with a structural drift check (`assertInProjectAllowListComplete()`) that throws if a new `Config` field is added without being explicitly classified, so a forgotten update is a safe default-deny instead of a silent RCE/secret-exfil vector. Put anything sensitive or per-project in `~/.wrongstack/config.json` or the non-committed `~/.wrongstack/projects/<hash>/config.local.json`. `.wrongstack/AGENTS.md` remains the canonical committed project memory.
- Tool-executed events are truncated before session-log write (threshold configurable) — assume the on-disk log is summarised, not raw.

