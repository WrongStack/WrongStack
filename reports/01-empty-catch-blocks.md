# Finding: Empty catch blocks silently swallow errors

**Severity:** Medium
**Category:** Reliability / Observability

## Description

Multiple production code paths use bare `catch {}` blocks that discard the thrown error entirely — no log, no metric, no rethrow. In several of these locations the swallowed exception is exactly the kind of failure an operator needs to see (process-kill failures, agent-loop pool iteration, director coordination). A silent failure here turns a diagnosable bug into "it just doesn't work".

## Evidence

Verified via ripgrep pattern `catch\s*(\(\w*\))?\s*\{\s*\}` over `packages/**/src/**/*.{ts,js}`:

| Location | Context |
|---|---|
| `packages/tools/src/pwsh.ts:343` | Fallback `child.kill()` after a failed registry kill on Windows — if this also throws, a timed-out `pwsh` child process is leaked with no trace. |
| `packages/tools/src/pwsh.ts:353` | Same fallback on POSIX path (`child.kill('SIGTERM')`). |
| `packages/core/src/core/agent-loop.ts:328` | Single-LLM tier walks its provider pool with a bare `catch {}` (the file's own comment at `packages/core/src/kernel/events/brain-events.ts:82` acknowledges this). |
| `packages/core/src/coordination/director.ts:388` | Director coordination step swallows exceptions. |
| `packages/cli/src/boot/system-prompt-menu.ts:256` | Boot-time menu step. |
| `packages/cli/src/boot/launch-menu.ts:704` | Launch menu step. |
| `packages/cli/src/pre-launch/launch-prompts.ts:221` | Pre-launch prompt step. |

Example (`packages/tools/src/pwsh.ts:338-345`):

```ts
if (typeof child.pid === 'number' && child.exitCode === null) {
  const attempted = registry.kill(child.pid, { force: true, graceMs: timeout });
  if (!attempted) {
    try {
      child.kill();
    } catch {}
  }
}
```

## Proposed remediation

1. Replace each bare `catch {}` with `catch (err) { logger.debug/warn(...) }` including the operation name and error message. The project already threads a `Logger` through most of these modules.
2. For `pwsh.ts` kill-fallbacks, log at `warn` level when both the registry kill and the direct kill fail — that means a process leak is occurring.
3. For the agent-loop pool walk, emit a per-provider failure event so the existing brain-event observability captures why a provider was skipped.
4. Add a lint rule (e.g. Biome `noEmptyBlockStatements` or ESLint `no-empty`) scoped to allow only commented empty catches, preventing regressions.

## Notes

Some of these are intentional best-effort cleanup paths (documented in `packages/plugin-sdk/src/runtime/h1-state.ts:12`), but even intentional ones should carry a debug-level log line.
