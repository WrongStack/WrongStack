# WrongStack Whole-System Audit Follow-up — 2026-08-13

**Repository:** `D:\Codebox\PROJECTS\WrongStack`  
**Version inspected:** `0.306.3`  
**Platform:** Windows, Node.js `>=22.19.0`, pnpm `11.21.0`  
**Status:** Two confirmed defects patched; remaining items are prioritized improvement opportunities

## Executive summary

WrongStack has strong defensive foundations: explicit package boundaries, strict TypeScript checks, a large automated test inventory, bounded WebSocket/HTTP inputs, structured permission and capability enforcement, local release gates, pinned workflow actions, build-lineage verification, and extensive lifecycle cleanup. No critical vulnerability was confirmed in this follow-up.

Two meaningful defects were reproduced and patched:

1. **High — decrypted HQ bearer token leaked into WebUI preference snapshots.** The server copied `hq.token` into shared `context.meta`; `prefs.get` then exposed it to every connected WebUI client. The token remains accepted as a write-only preference but is no longer seeded or returned.
2. **Medium — corrupt or unreadable project manifests were treated as empty.** `loadManifest()` swallowed every read/parse error and returned `{ projects: [] }`, allowing subsequent writes to replace project history. Only `ENOENT` now means “no manifest”; read and validation failures throw structured errors.

The highest-value remaining work is architectural rather than emergency remediation: break the unexpected runtime cycle, reduce the CLI aggregation package's dependency fan-out, decompose the largest responsibility-heavy modules, raise WebUI per-file coverage, and close explicitly skipped security/correctness regressions.

## Method and evidence boundaries

This review combined:

- independent architecture/code-quality, security, performance/resource-lifecycle, and test/dependency passes;
- current-source re-verification of candidate findings before mutation;
- the canonical August 2026 subsystem audit in `docs/audit-2026-08/`;
- the generated architecture inventory in `docs/reports/architecture-health-current.md`;
- the RAM/lifecycle inventory in `reports/ram-leak-audit.md`, with stale claims checked against current source;
- focused regression tests, scoped lint, package typechecks, and dependency audit after the patches.

This is a whole-system risk scan, not a claim that every one of the repository's 724,049 production lines was manually reviewed. Existing audit claims were treated as hypotheses: resolved or contradicted findings were not re-reported as open defects.

## Confirmed defects and patches

### WS-AUD-01 — HQ bearer token exposed through preference snapshots

**Severity:** High  
**Area:** Security / WebUI server  
**Files:**

- `packages/webui-server/src/server/context-meta.ts`
- `packages/webui-server/src/server/pref-helpers.ts`
- `packages/webui-server/tests/context-meta.test.ts`
- `packages/webui-server/tests/pref-helpers.test.ts`

**Root cause:** `seedContextMeta()` copied the decrypted `config.hq.token` into `context.meta`. `prefSnapshot()` projected `hqToken`, so a `prefs.get` response disclosed a bearer credential over the normal WebSocket preference channel.

**Fix:**

- stopped seeding `hqToken` into shared context metadata;
- removed `hqToken` from the preference snapshot allow-list;
- retained inbound `hqToken` validation/persistence, making the setting write-only;
- added regression assertions that configured and default snapshots do not contain the key.

**Security effect:** Compromise or misuse of an authenticated WebUI connection can no longer recover the persisted HQ bearer token through preference reads. This does not change token rotation or storage-at-rest behavior.

### WS-AUD-02 — Project manifest corruption collapsed to an empty registry

**Severity:** Medium  
**Area:** Data integrity / CLI  
**Files:**

- `packages/cli/src/services/project-manifest.ts`
- `packages/cli/tests/project-manifest.test.ts`

**Root cause:** A broad `catch` covered missing files, permission failures, I/O failures, malformed JSON, and invalid shapes. Every case returned an empty manifest. A later save could therefore overwrite a valid-but-temporarily-unreadable or corrupt manifest with a new empty/small registry.

**Fix:**

- only `ENOENT` returns `{ projects: [] }`;
- other read failures throw `ConfigError` with phase `manifest-read`;
- malformed JSON and invalid `projects` shapes throw `CONFIG_PARSE_FAILED` with phase `manifest-parse`;
- regression tests cover missing, malformed, and structurally invalid manifests.

**Integrity effect:** The CLI now fails closed instead of silently converting damaged or inaccessible state into “no projects.”

## Architecture and code quality

### Current architecture snapshot

The generated inventory reports:

- **31** workspace packages;
- **2,939** production source files and **724,049** production lines;
- **2,613** test files;
- **95** workspace dependency edges and **8,976** relative-module edges;
- **2** runtime module cycles and **18** type-inclusive cycles;
- **0** test files missing TypeScript test-project coverage.

### Priority opportunities

#### A1 — Break the unexcepted runtime cycle

**Priority:** High  
**Evidence:** `docs/reports/architecture-health-current.md` reports one unexcepted cycle. The runtime cycles are:

- `packages/core/src/core/context.ts` ↔ `packages/core/src/core/conversation-state.ts`;
- Kanban manager/lifecycle/remote-storage/storage cycle.

**Recommendation:** First identify which cycle is intentionally excepted in the architecture registry, then break the other by extracting shared types/state transitions into a dependency-neutral module. Add the resulting direction as an architecture ratchet rather than suppressing the cycle.

#### A2 — Reduce `@wrongstack/cli` as a dependency hub

**Priority:** Medium  
**Evidence:** The CLI package depends on 22 workspace packages, including frontend, desktop, server, runtime, storage, and protocol packages. This increases build invalidation, makes package boundaries harder to reason about, and encourages command registration cycles.

**Recommendation:** Keep the binary composition root in CLI, but move feature-specific command implementations behind narrow adapters or optional entry points. Avoid introducing a new abstraction until a concrete edge can be removed and verified by `check:architecture`.

#### A3 — Decompose responsibility-heavy modules

**Priority:** Medium  
**Evidence:** The generated largest-file list includes `path-guard/index.ts` (1,996 lines), `tool-call-memory.ts` (1,593), codebase-index `writer.ts` (1,484), `compaction-core.ts` (1,427), CLI Kanban commands (1,396), and multiple UI/server modules above 1,100 lines.

**Recommendation:** Refactor by cohesive behavior, not line-count alone. Best first candidates are modules that combine protocol parsing, state mutation, persistence, and presentation. Preserve public exports and establish characterization tests before extraction.

#### A4 — Reduce test-only runtime export surface

**Priority:** Medium  
**Evidence:** **795** runtime exports are referenced by tests but no production file. This is already frozen by `architecture/test-only-exports.json`, preventing growth.

**Recommendation:** Continue the ratchet. When touching a listed module, prefer testing through its production entry point or move pure helpers into explicit internal test-support modules. Do not bulk-delete exports: dynamic/plugin/public consumers must be checked first.

## Security posture

### Verified strengths

Current source and the August audit establish:

- separator-aware shell trust matching;
- agent-state write protection across path-bearing tool fields;
- dangerous-capability downgrade and Kanban lease/boundary checks;
- AES-256-GCM vault storage with atomic key writes and platform-aware hardening;
- Host/Origin checks, constant-time token comparison, secure bootstrap cookies, CSP/frame/nosniff/referrer headers;
- bounded HTTP bodies, 20 MiB WebSocket frames, and a default per-connection work-message budget;
- protocol decoding that rejects unsafe object keys and excessive nesting;
- pinned GitHub Actions and `persist-credentials: false`.

### Open security opportunities

#### S1 — Re-enable the skipped absolute-path escape regression

**Priority:** Medium  
**Evidence:** `packages/tools/tests/design.test.ts` unconditionally skips the test that should reject an absolute materialization path outside the project root (issue #249).

**Risk:** The relative-path escape case is tested, but the platform/realpath-sensitive absolute-path boundary lacks active regression coverage.

**Recommendation:** Fix the containment check around canonical parent paths and re-enable the test on Windows, Linux, and macOS path semantics.

#### S2 — Verify sibling OAuth abort-listener cleanup

**Priority:** Low  
**Evidence:** `reports/ram-leak-audit.md` confirms the Anthropic OAuth path removes its external abort listener in `finally`, but leaves OpenAI Codex and GitHub Copilot sibling flows as unverified.

**Recommendation:** Add symmetric add/remove listener tests for all OAuth flows. Treat this as defensive lifecycle validation, not a confirmed leak.

#### S3 — Keep credentials write-only across all settings surfaces

**Priority:** Medium  
**Evidence:** WS-AUD-01 showed that a secret could pass through a generic preference snapshot allow-list.

**Recommendation:** Introduce a test-level invariant that known credential keys (`token`, `apiKey`, bot tokens, vault material) never appear in snapshots or server-to-client preference messages. Prefer a deny-by-construction schema over repeated field redaction.

## Performance and resource lifecycle

### Verified strengths

- Long-lived reviewed intervals use `.unref()` and explicit disposal.
- Session history, event listeners, caches, pending requests, terminal counts/output, and WebSocket work are generally bounded.
- Session watch replay uses a bounded tail ring instead of materializing an entire large journal per poll.
- Goal-state fan-out computes serialized byte length once per broadcast; the prior 10K-task/100-client benchmark improved from 48.64 ms to 4.91 ms.
- The recent RAM audit's high/medium listener and pending-confirm findings are closed in current source.

### Open performance opportunities

#### P1 — Clean bounded stale chat-suppression entries symmetrically

**Priority:** Low  
**Evidence:** `suppressedChatEchoes` is capped at 32 entries per response type, but expired timestamps are removed only on consume. The documented worst case is about 6.5 KiB.

**Recommendation:** Fold pruning into existing insert/disconnect activity rather than add a dedicated timer. This is cleanup consistency, not a material leak.

#### P2 — Measure before optimizing the largest hot-path modules

**Priority:** Medium  
**Candidates:** compaction, codebase-index writing, memory injection, WebSocket health, and UI state projection.

**Recommendation:** Add benchmark/heap evidence before structural optimization. Existing benchmark tooling (`bench`, `bench:perf`, memory-profile scripts) should produce baselines for representative 1K/10K workloads. Avoid line-count-driven performance rewrites.

#### P3 — Continue lifecycle symmetry tests

**Priority:** Medium  
**Recommendation:** For every object that registers a process, socket, abort, watcher, worker, or interval callback, test the exact reference is removed/closed on success, error, abort, reconnect, and dispose. This pattern already caught real desktop, ACP terminal, and WebUI pending-confirm retention defects.

## Test coverage and quality gates

### Strengths

- Test inventory is unusually large: **2,613** files against **2,939** production files.
- All test files are covered by exactly one TypeScript test project.
- `scripts/check-test-typecheck.mjs` rejects new diagnostic counts and unparsed project failures against a baseline.
- Root release validation includes dependency audit, build, generated catalog checks, package contracts, artifact lineage, architecture, test inventory/skips/types, native-module checks, i18n, typecheck, and coverage.

### Open test opportunities

#### T1 — Raise WebUI coverage with per-file accountability

**Priority:** High  
**Evidence:** `packages/webui/vitest.config.ts` currently enforces aggregate thresholds of **53% statements, 44% branches, 45% functions, and 55% lines**, with `perFile: false`.

**Risk:** Well-tested modules can mask nearly untested stateful components or hooks.

**Recommendation:** Keep the global ratchet, add a no-zero-coverage rule for changed production files, then introduce per-file floors gradually for security-sensitive hooks, WebSocket handling, settings, and session state.

#### T2 — Resolve the skipped SDD graph-generation test

**Priority:** Medium  
**Evidence:** `packages/sdd/tests/sdd-interview-driver.test.ts` skips deterministic graph generation during approve→executing when no task array was emitted.

**Recommendation:** Determine whether the behavior is obsolete or broken. Remove the test if the contract changed; otherwise restore deterministic generation and re-enable it. An indefinite skip leaves a core SDD transition unprotected.

#### T3 — Keep skipped-test and type-diagnostic budgets non-growing

**Priority:** Medium  
**Evidence:** The repository already has `check:test-skips` and `check:test-types` gates.

**Recommendation:** Require every new skip to include an owner/issue and expiration condition; ratchet existing baselines downward when a file is touched.

## Dependency integrity and supply chain

### Verified posture

- pnpm is pinned through the root `packageManager` field.
- Workspace dependencies use `workspace:*` consistently in the inspected packages.
- Release validation runs `pnpm audit --audit-level=moderate` before build/publish gates.
- GitHub Actions are pinned by SHA, use minimal permissions, disable checkout credential persistence, and use frozen lockfile installation.
- Build artifacts are lineage-checked before downstream use.
- npm trusted publishing/OIDC provides release provenance.

### Open dependency opportunities

#### D1 — Add a machine-readable SBOM as a release artifact

**Priority:** Low  
**Rationale:** Provenance proves origin but does not inventory transitive components for incident response. Generate CycloneDX or SPDX from the frozen lockfile without changing runtime dependencies.

#### D2 — Make dependency drift visible without auto-updating

**Priority:** Low  
**Recommendation:** Add a scheduled/read-only outdated report grouped by runtime/dev/optional scope. Keep updates manual and package-specific; do not combine broad dependency churn with functional changes.

#### D3 — Preserve exact toolchain pinning

**Priority:** Medium  
**Evidence:** Core toolchain entries are exact, while normal runtime dependencies use compatible ranges.

**Recommendation:** Keep package-manager and build/test toolchain pins exact. For runtime packages, rely on frozen lockfile plus audit; only tighten ranges when a reproducible incompatibility justifies it.

## Validation performed for this follow-up

The patch set was validated with:

- focused Vitest coverage for project manifest and WebUI preference metadata/snapshot behavior;
- scoped Biome lint for the changed TypeScript files;
- TypeScript checks for `@wrongstack/cli` and `@wrongstack/webui-server`;
- dependency audit at the configured severity threshold;
- an independent Chimera diff review, which reported no actionable finding after the stale HQ-token test expectation was corrected.

The full monorepo release/coverage chain was not rerun during this follow-up because the working tree contained substantial concurrent changes owned by other sessions. The narrower checks establish the changed contracts; repository-wide integration remains a separate shared-tree validation concern.

## Prioritized roadmap

| Priority | Item | Type | Status |
|---|---|---|---|
| P0 | Stop HQ token preference disclosure | Security | **Patched and focused-tested** |
| P0 | Fail closed on corrupt/unreadable project manifest | Data integrity | **Patched and focused-tested** |
| P1 | Break the unexcepted runtime cycle | Architecture | Open |
| P1 | Re-enable absolute design-output escape regression | Security/test | Open |
| P1 | Add changed-file/per-file WebUI coverage floors | Test quality | Open |
| P2 | Resolve skipped SDD graph-generation contract | Correctness/test | Open |
| P2 | Reduce CLI dependency fan-out and oversized mixed-responsibility modules | Architecture | Open |
| P2 | Add generalized secret non-disclosure snapshot invariants | Security | Open |
| P3 | Add SBOM and read-only dependency drift reporting | Supply chain | Open |
| P3 | Consolidate bounded TTL cleanup and OAuth listener symmetry tests | Lifecycle | Open |

## Files changed by this audit

- `packages/cli/src/services/project-manifest.ts`
- `packages/cli/tests/project-manifest.test.ts`
- `packages/webui-server/src/server/context-meta.ts`
- `packages/webui-server/src/server/pref-helpers.ts`
- `packages/webui-server/tests/context-meta.test.ts`
- `packages/webui-server/tests/pref-helpers.test.ts`
- `docs/audit-2026-08/11-system-audit-follow-up-2026-08-13.md`

No dependency, lockfile, schema, CI, or public API change was made by this audit.
