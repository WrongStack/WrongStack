# Working Tree Status Report — 2026-07-11

**Generated:** 2026-07-11T19:45 UTC  
**Branch:** `main` (clean ancestry, 184 uncommitted files)  
**Version:** `0.285.0`  
**Delta:** `+3350 / -2349` lines across 184 files

---

## Resolution update — completed 2026-07-11

This report is retained as the before-state. Its actionable findings were closed as follows:

- **Super Memory:** graph persistence/traversal, anchor verification (file/directory/symbol/content hash/git blob), hygiene, candidates, session consolidation, legacy import, turn/tool injection, rich tools, slash commands, session/file-change automation, typed events, and WebUI/TUI observability are implemented with expanded tests.
- **CLI refactor:** the grouped `ExecuteDeps` contract is live; shared controller factories are wired into `main()`, the unsafe mutable `WireContext` prototype was removed, and the typed `toExecuteDeps()` boundary plus controllers have tests.
- **Dependencies:** `jszip` was removed from runtime and replaced by a built-in, validated ZIP codec; WebUI HQ moved to Vite 8/plugin-react 6 and its Rolldown config was migrated; patch-level audit items were aligned.
- **Build system + TypeScript 7:** all 19 `tsup` configurations were replaced by the centralized `scripts/build-package.mjs` driver (esbuild for JavaScript, native `tsc --emitDeclarationOnly` for types). The workspace now runs TypeScript 7.0.2. Runtime features that still need the legacy compiler API use the official `@typescript/typescript6` compatibility package, while project builds and typechecks use TypeScript 7.
- **Security discovered during closure:** repo-controlled `Sage.storage.directory` is now stripped from in-project config, and Super Memory independently rejects absolute or escaping storage paths.

Verification results are recorded in the final task handoff; the sections below describe the original snapshot and are intentionally not rewritten.

---

## 1. Project Health Snapshot

| Check | Status |
|-------|--------|
| Working tree | Uncommitted (no staged / partial staged) |
| Untracked files | 11 (new source files) |
| Remote divergence | `main` is ahead of `origin/main` — 6 unreachable local commits |
| Longest untouched code area | `packages/core/src/kernel/` (~1670 lines, stable) |
| Package count | 20 workspace packages + website |
| Active development surfaces | CLI, sage, security, TUI, providers |

---

## 2. Active Work Streams

### 2.1 Super Memory (`packages/sage/`)

**Status:** Early implementation, ~60% of architecture plan done

**Implemented:**
- `SageStore implements MemoryStore` — full legacy API bridge
- JSONL storage with file-locked append, corrupt-line quarantine, atomic snapshot writes
- Lexical/path/tag/kind indexes with JSON persistence
- `createSageToolCallMiddleware` — injects memory hints into tool results via `toolCall` pipeline (read/tree/grep/glob/codebase_search/bash/write/edit/patch triggers)
- In-memory cooldown to prevent repeat injection spam
- Secret/credential rejection on `rememberSuper`
- CLI wiring module (`packages/cli/src/wiring/sage.ts`) ready

**Still Missing (per architecture plan):**
- Graph engine (`graph/edges.jsonl` + traversal)
- Hygiene engine (dedup, merge, stale, archive, supersede, contradict)
- Verifier (file content hash, git blob, symbol existence)
- Symbol / command / git blob anchors
- Session consolidation v2
- Slash commands (`/memory show`, `/memory graph`, `/memory hygiene`)
- Tools (`memory_for_file`, `memory_search`, etc.)
- WebUI / TUI observability surfaces
- Legacy `memory.md` import
- Full test coverage (only `store.test.ts` exists)

**Files:** `8 source + 1 test`

### 2.2 CLI Refactor — ExecutionDeps / WireContext

**Status:** Phase 1–3 coded, not yet wired into `main()`

**Implemented:**
- `packages/cli/src/execute-deps.ts` — 8 focused sub-interfaces replacing monolithic `ExecutionDeps` (~80 fields)
- `packages/cli/src/wiring/controllers.ts` — extracted controller factories (Interrupt, Enhance, FleetStream, AgentsMonitor, StatuslineConfig)
- `packages/cli/src/wiring/to-execute-deps.ts` — `WireContext` state bag + `toExecuteDeps()` builder

**Remaining:**
- `main()` in `cli-main.ts` is still 2400+ lines using old wiring pattern
- `WireContext` is defined but likely unused in `main()`
- No tests for controllers or `toExecuteDeps`
- Phase 4 (PickerDeps consolidation) not started

### 2.3 Security Hardening

**Scope:** Major rewrite of `SECURITY.md` + new internal modules

| File | Change |
|------|--------|
| `SECURITY.md` | Full rewrite — adversary model, controls inventory, risk register |
| `packages/core/src/security/config-secrets.ts` | New — local config secret encryption |
| `packages/tools/src/_fetch-guard.ts` | New — SSRF guard for fetch tool |
| `packages/tools/src/_redact-command.ts` | New — command output redaction |
| `packages/core/src/security/permission-policy.ts` | Major revision (+121/-121) |

### 2.4 Provider Changes

| Provider | Changes |
|----------|---------|
| `github-copilot.ts` | Major rewrite |
| `github-copilot-token.ts` | New file |
| `openai-codex.ts` | Significant revision |
| `openai-codex-account.ts` | New file |
| `oauth/chatgpt.ts` | Minor |
| `oauth/copilot.ts` | Minor |

### 2.5 TUI Overhaul

- `app.tsx` — major rewrite (+256/-256)
- `run-tui.ts` — +59 lines
- `app-reducer.ts` — +6
- `app-state.ts` — minor

### 2.6 WebUI Polish

- `settings` Appearance tab — thinking log / tool call grouping toggles
- `ConfirmDialog` — YOLO mode refinements
- `SessionPanel` / `AgentsPanel` — minor updates
- i18n — Turkish & English translations updated

### 2.7 Dependency Audit (`techstack.md`)

Automated scan of 62 third-party packages across 22 `package.json` files.

| Severity | Count | Notable |
|----------|-------|---------|
| 🟢 Up to date | 55 | — |
| 🟡 Outdated | 3 | `typescript` 6→7 (major), `webui-hq` vite/plugin-react (2 majors behind) |
| 🔴 Critical | 1 | `jszip` — 4 years without a release |

---

## 3. Risk Matrix

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| DTS drift from stale `dist/` | Build failure | High — 184 files changed | Run `pnpm build` before `pnpm typecheck` |
| Super Memory storage corrupt before hygiene exists | Silent data loss | Medium | Add hygiene engine before production use |
| WireContext unused in `main()` | Dead code, refactor incomplete | High — need verification | Check `cli-main.ts` imports |
| TypeScript 7 release breaks tsup/types | Blocked upgrades | Medium | Plan branch + test TS 7 compatibility |
| GitHub Copilot provider may have regressions | Provider failure | Medium | Run provider integration tests |
| `pnpm-lock.yaml` drift | Workspace resolution errors | Low | `pnpm install` |

---

## 4. Recommended Action Plan

### Immediate (urgent — unblocks everything else)

```bash
pnpm build          # rebuild all dist/
pnpm typecheck      # catch DTS / type mismatches
pnpm test -r        # full test suite
pnpm lint           # style consistency
```

### Priority 1 — Super Memory completion

| Phase | What | Depends on |
|-------|------|------------|
| 4 | Hygiene engine (dedup, merge, stale, archive) | Storage layer done |
| 5 | Verifier (file hash / git blob / symbol) | Paths + anchors done |
| 6 | Graph edges + traversal | Storage done |
| 7 | Slash commands + tools | Core retrieval done |
| 8 | Test coverage (middleware, cooldown, format, hygiene, graph) | All phases |

### Priority 2 — CLI Refactor landing

| Step | What | Risk |
|------|------|------|
| 3.1 | Wire `WireContext` into `main()` | Medium — verify all 80 fields mapped |
| 3.2 | Remove old `ExecutionDeps` | Low after 3.1 passes |
| 4 | PickerDeps consolidation + tests | Low |

### Priority 3 — Dependency hygiene

- TypeScript 7 migration branch (`feat/ts7-prep`)
- `jszip` → native `CompressionStream` (Node 22+)
- `webui-hq`: `vite ^6.0.0` → `^8.1.4`, `@vitejs/plugin-react ^4.3.0` → `^6.0.3`

---

## 5. Appendices

### A. Changed files by package

| Package | Files changed | Insertions / Deletions |
|---------|--------------|------------------------|
| `packages/cli` | ~35 | Heavy |
| `packages/core` | ~30 | Heavy |
| `packages/tools` | ~15 | Moderate |
| `packages/tui` | ~8 | Heavy (app.tsx rewrite) |
| `packages/webui` | ~12 | Moderate |
| `packages/providers` | ~6 | Moderate |
| `packages/sage` | 9 new | All new |
| Other packages | ~30 | Light (version bumps) |
| Docs | ~15 | Light |
| Root config | ~4 | Light |

### B. Untracked files

```
docs/plans/cli-main-executiondeps-refactor.md
docs/plans/sage-architecture.md
packages/acp/src/integration/run-one-acp-task.ts
packages/cli/src/execute-deps.ts
packages/cli/src/wiring/controllers.ts
packages/cli/src/wiring/sage.ts
packages/cli/src/wiring/to-execute-deps.ts
packages/cli/tests/hq-security-hardening.test.ts
packages/core/src/security/config-secrets.ts
packages/providers/src/github-copilot-token.ts
packages/providers/src/openai-codex-account.ts
packages/sage/
packages/tools/src/_fetch-guard.ts
packages/tools/src/_redact-command.ts
packages/webui-server/src/server/provider-config-standalone.ts
techstack.md
```

### C. Branches in play

| Branch | Relation |
|--------|----------|
| `main` | Current — 6 commits ahead of origin |
| `chore/pr-00-clean-baseline` | Local only |
| `feat/pr-07-package-contract-smoke` | Local only |
| `fix/pr-02-ws-state-machine` | Local only |
| `fix/pr-03-watcher-debug-auth` | Local only |
| `fix/pr-04-tui-signal-lifecycle` | Local only |
| `fix/pr-05-scanner-cancellation` | Local only |
| `refactor/pr-*` | 8 local refactor PR branches |
| `feat/tuneup` | Local + origin |
| 8 remotes/origin/* | Unmerged upstream branches |

### D. Key files for next steps

| File | Purpose |
|------|---------|
| `docs/plans/sage-architecture.md` | Super Memory design spec |
| `docs/plans/cli-main-executiondeps-refactor.md` | CLI refactor plan |
| `packages/sage/src/store.ts` | Core store implementation |
| `packages/sage/src/middleware/tool-call-memory.ts` | Pipeline auto-injection |
| `packages/cli/src/execute-deps.ts` | New sub-interfaces |
| `packages/cli/src/wiring/to-execute-deps.ts` | WireContext builder |
| `packages/cli/src/cli-main.ts` | ~2400-line orchestrator — refactor target |
| `SECURITY.md` | Threat model & controls |
| `techstack.md` | Dependency audit |
