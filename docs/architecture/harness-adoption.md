# Harness ideas adopted in WrongStack

This is the implementation boundary for the DeepSeek Harness comparison on
2026-10-03. Changes extend WrongStack's existing contracts; no Cordis dependency,
second agent loop, second memory store, or parallel session log was added.

## Changes

| Area | Implemented behavior | Main verification |
|---|---|---|
| Structured ToolFlow | `tools.data(name, input)` receives validated, scrubbed canonical JSON through the existing nested execution gate. Text calls stay compatible. Read, grep and glob opt in with output schemas; content reads can expose unnumbered `raw_text`. | `packages/core/tests/core/nested-tool-call.test.ts`, `packages/core/tests/utils/tool-programmatic-output.test.ts`, `packages/toolflow/tests/tool-script.test.ts` |
| Registration ownership | Plugin API registrations are drained on shutdown and partial setup failure. Exact registration identities preserve independent later writes; scoped override stacks skip unloaded ancestors. Tool wrapper removal recomposes surviving pure decorators. | `packages/core/tests/plugin/registration-lifetime.test.ts`, existing plugin/extension/registry suites |
| Compaction ownership | The canonical journaled compactor checks ownership after its durability flush. Stale results cannot update counters, clear file tracking, publish manual success, or claim recovery/autonomy savings. CLI/TUI, WebUI, context manager, overflow recovery and autonomy use the same validity check. | `packages/core/tests/execution/strategy-compactor.test.ts`, `packages/cli/tests/slash-compact.test.ts`, `packages/webui-server/tests/session-context-ops-per-session.test.ts` |

ToolFlow data is execution-local, kept out of provider blocks and durable logs.
Only the script's selected return value/log output enters the conversation.
The structured boundary is bounded at 8 MiB, 64 nested levels and 250,000 values;
content-changing result policies invalidate the earlier canonical value. A
failed structured result can follow an already executed tool, so mutation retries
must inspect prior effects. No new permission or automatic replay route exists.

Registry ownership covers API registrations. Raw container/registry writes and
external resources retain their existing cancellation and teardown contracts.
Surviving tool wrappers must be pure decorators because removal can recompose
them; a failed recomposition removes the tool instead of leaving unloaded code.

## Existing behavior retained and verified

| Suggested idea | Current WrongStack implementation | Decision |
|---|---|---|
| Cache-safe dynamic context | `core/system-prompt-builder.ts`, `core/agent-response.ts` and provider adapters split stable and volatile prompt regions and re-home dynamic material at the request tail. | Keep this mechanism; run epoch/prefix stability regressions. A second change-only snapshot protocol would add complexity without a demonstrated provider benefit. |
| Consistent reconnect state | WebUI's `session-frame-log.ts`, `session-event-resume.ts` and the shared protocol `frame-resume.ts` provide per-session sequences, a process epoch, ordered catch-up and transcript fallback. HQ has its own canonical resume gate. | Keep those sequence and ownership contracts; run reconnect/session-isolation regressions. A universal projection framework is deferred until a concrete domain consistency defect needs it. |
| Replayable compaction | `JournaledCompactor` writes and flushes an exact `context_snapshot`; conversation replacement events and compaction reports already retain reconstruction and audit information. | Strengthen existing report ownership rather than introduce another transaction log. |
| Profiles and diagnostics | WrongStack already resolves named configuration profiles and has CLI/TUI/WebUI/ACP/headless wiring and diagnostic surfaces. | Keep the existing composition model. Config-only diagnostics must not claim to be a live plugin tree; a full plugin-tree launcher rewrite is not justified by this comparison. |
| Output spill | The tool executor already persists large results and returns head/tail previews with retrieval paths; ToolFlow already limits model-visible intermediate output. | Retain artifact and budget handling. Structured access does not replace or bypass the normal text/journal path. |

## Proof boundary

The regression suite uses real Agent/ToolExecutor flows with scripted providers,
plus registry and reconnect tests. These establish contracts and isolation; they
do not measure live model reasoning, paid-provider costs, latency, or browser
visual quality. Existing ToolFlow byte fixtures measure rendered result text,
not the size of execution-local canonical JSON, and are not new structured-mode
performance claims. Full-test and build results are recorded separately under
`.reports/harness-adoption-2026-10-03/`.

References: [DeepSeek tool composition](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/tools/README.md),
[scoped registration](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/scope.md),
[session projections](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session-projection.md),
[prompt context](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/system-prompt.md),
[architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md).
