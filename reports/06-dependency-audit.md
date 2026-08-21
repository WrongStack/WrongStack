# Finding: Dependency vulnerability audit — clean (no known CVEs)

**Severity:** None (informational — clean result)
**Category:** Supply-chain / Dependency security

## Description

A workspace-wide `pnpm audit` (severity threshold: low and above) was run against the WrongStack workspace on 2026-08-21. It reported **zero known vulnerabilities** across all dependency classes.

## Evidence

Raw audit output (exit code 0):

```json
{
  "advisories": {},
  "metadata": {
    "vulnerabilities": {
      "info": 0,
      "low": 0,
      "moderate": 0,
      "high": 0,
      "critical": 0
    },
    "dependencies": 351,
    "devDependencies": 236,
    "optionalDependencies": 182,
    "totalDependencies": 686
  }
}
```

- Advisories: empty (`{}`) — no matching CVE/advisory entries for any installed version.
- Scope: 686 total dependencies (351 runtime, 236 dev, 182 optional) resolved from the workspace lockfile.
- **Re-verified 2026-08-21 after a workspace-wide dependency bump** (13 package manifests + lockfile): identical clean result — 0 advisories across all severities, same dependency totals.

## Caveats

- `pnpm audit` only detects **known, published** vulnerabilities in the *resolved* dependency versions. It says nothing about: unmaintained packages, malicious new releases published after the audit database snapshot, typosquatting, or install/lifecycle-script risk.
- The result is a point-in-time snapshot; it should be re-run in CI on every lockfile change.

## Proposed remediation (preventive)

1. Add `pnpm audit --audit-level high` as a CI gate — see wiring verification below: the shipped gate plugin exists but is **opt-in (inactive by default)**, so it does not cover default sessions.
2. Schedule a periodic (e.g. weekly) audit run so newly published advisories against already-locked versions are caught without a lockfile change.
3. Consider `pnpm outdated` / renovate-style automation for security-driven version bumps.

## Plugin wiring verification (2026-08-21)

Whether `dependency-vulnerability-gate` is wired into the pipeline — **verified**:

- **Implementation**: `packages/plugins/src/dependency-vulnerability-gate/index.ts` registers a `PostToolUse` hook with matcher `install|bash|exec` (line 433) plus a `dependency_audit_status` diagnostic tool (lines 436–462). Install detection covers the `install` tool and shell commands parsed via `parseInstallCommands` (lines 212–221); package-manager detection probes lockfiles for pnpm/bun/yarn/npm (lines 234–252).
- **NOT loaded by default**: the plugin audit catalog at `packages/plugins/src/audit/index.ts:347–353` declares `defaultState: 'inactive'` (risk: high, canDisable: true). `packages/cli/tests/wiring-plugins.test.ts:377` explicitly asserts `expect(names).not.toContain('dependency-vulnerability-gate')` for default loading. It is an opt-in built-in — it only loads when enabled via `wstack plugin enable dependency-vulnerability-gate` or config `extensions["dependency-vulnerability-gate"].enabled = true` (enablement resolved through `resolvePluginEnablement` in `packages/cli/src/plugin-management.ts:619–624`). `docs/plugin-audit-2026-07-10.md:117,128` documents it as off by default.

**Failure threshold audit:**

- Defaults are `severityThreshold: 'high'`, `block: true`, `timeoutMs: 120s` (lines 83–88). Config validation only accepts `low|moderate|high|critical` and falls back to `high` on any invalid value (lines 98–115).
- Comparison logic is correct: `exceedsThreshold` ranks severities (`info:0 … critical:4`) and triggers on `maxRank >= thresholdRank` (lines 200–206) — i.e. at-or-above, matching the documented behavior. npm/pnpm's non-zero exit code on findings is handled (stdout is authoritative, lines 293–301); parser handles both per-advisory `vulnerabilities` objects and pnpm's `metadata.vulnerabilities` counts fallback (lines 139–198).

**Gaps found during the audit of the gate itself:**

1. ~~**Fail-open on execution errors**~~ **Fixed (2026-08-21)**: when `runAudit` returns `null` (timeout or unparseable output), the hook now increments `audit_errors`, logs a warning (`api.log.warn`), and injects `additionalContext` telling the operator the dependencies were NOT vetted — see `packages/plugins/src/dependency-vulnerability-gate/index.ts:388-403` and the timeout/unparseable-output tests in `packages/plugins/tests/dependency-vulnerability-gate.test.ts` (17/17 passing).
2. **Post-hoc blocking**: the hook is `PostToolUse`, so with `block: true` the install has already completed when the block decision fires — it stops the turn, not the install.
3. ~~`severityThreshold: 'high'` (default) lets `moderate` findings pass silently~~ **Resolved (2026-08-21)**: threshold stays `high`, but sub-threshold findings are no longer silent — the hook now injects an informational `additionalContext` (max severity + counts) whenever the audit finds any vulnerabilities below the threshold, and stays silent only on a fully clean audit. See `packages/plugins/src/dependency-vulnerability-gate/index.ts:415-430` and the "does not block moderate severity when threshold is high" / "stays fully silent when audit is clean" tests (18/18 passing).

## Design decisions (2026-08-21)

**1. Enable `dependency-vulnerability-gate` by default? — No (stays opt-in).**

Rationale: the repo's plugin governance is deliberately risk-based — the audit catalog declares this plugin `risk: 'high'` / `defaultState: 'inactive'` (`packages/plugins/src/audit/index.ts:347-353`) because it runs synchronous audits (up to 120s timeout) on the PostToolUse path and can block turns. Making a blocking, latency-adding hook default-active would contradict the governance model, require catalog/wiring-test/docs changes, and put default security coverage in the wrong layer. Default coverage belongs in CI (a scheduled/lockfile-triggered `pnpm audit --audit-level high` gate); the in-session hook remains available via `wstack plugin enable dependency-vulnerability-gate` for operators who want install-time enforcement.

**2. Lower `severityThreshold` from `high` to `moderate`? — No (stays `high`), with sub-threshold visibility added instead.**

Rationale: with `block: true`, a `moderate` threshold would block frequent agent-driven installs on noisy advisories that often cannot be fixed without major version upgrades — friction that trains operators to disable the gate. The genuine defect was that sub-threshold findings were *fully silent*; that is now fixed (informational context injected, nothing blocked). If the workspace later wants stricter enforcement, the supported path is config: `extensions["dependency-vulnerability-gate"].severityThreshold = "moderate"` — no code change needed.

No action is required for the current tree.

