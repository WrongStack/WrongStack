# WrongStack ToolFlow

WrongStack ToolFlow composes tool calls in an async JavaScript function through
the `tool_script` tool. Compose tools. Return answers.
Intermediate results stay in the script; the returned value, a call summary,
measured byte counts, and any console output reach the model, subject to the
executor's normal preview/artifact handling. The underlying operations still
run and are journaled individually.

Use it for repeated reads, dependent queries, and reducing large structured
results before the next model decision. Use direct calls for simple operations.
Inspect existing Project Kits first for reusable project-specific operations.

Set the optional `description` to a short purpose such as "Summarize package
versions". The activity summary shows that purpose instead of a raw script dump.
WebUI and TUI label direct and deferred calls as **WrongStack ToolFlow**.
Completed runs show the call count and measured result/returned bytes. WebUI's
expanded activity card also offers the JavaScript for inspection.

The `ToolFlow bytes: X -> Y; calls: N; failed: F` suffix measures UTF-8 tool-result text (`X`) and
script text including the rendered return value, call summary, and console
output (`Y`), before the metrics suffix and executor preview/artifact handling.
The activity card's ordinary output-size field measures the model-visible result
after that handling. These two sizes can differ for large returns.
Neither is a measurement of tokens, cost, or latency.
Caught tool failures remain visible in the failure count even if the script
finishes normally.

## Discover and compose

`tools.names()` lists the enabled executable catalog, including tools whose
schemas are deferred. `tools.describe(name)` returns a tool's exact input schema,
its optional structured `outputSchema`,
description, usage guidance, permission, and mutation flag inside the VM without
executing a tool. Use these to build correct arguments; do not guess schemas.

Call a tool with `await tools.read(input)` or `await tools.call(name, input)`.
Names containing hyphens and the reserved helper names `call`, `data`, `names`, and
`describe` use `tools.call`. Results are text; parse JSON only for tools that
return JSON. Failures throw and can be handled with `try`/`catch`.

`await tools.data(name, input)` opts into validated, secret-scrubbed JSON for
tools declaring `outputSchema`. Built-in `read`, `grep`, and `glob` support it.
Existing text calls keep their current behavior. The executor runs the same
validation, permission, confirmation, hook, journal, and session gate once;
unsupported tools are rejected before execution. Structured values stay local
to the script and are not copied into provider blocks or journals.
Validation uses WrongStack's existing supported JSON Schema subset.

For a UTF-8 content read, `raw_text` contains unnumbered text. Check
`truncated` and that `raw_text` exists before parsing. Summary reads, cached
diagnostics, and non-text reads may omit it; inspect `text`, `cached`, `encoding`,
and `note` rather than treating a diagnostic as file content. Structured search
results also expose their own truncation flags.

For example, set `description` to "Summarize package versions" and supply this
as the `script` input after checking the read input/output schemas. Structured
results avoid parsing the display header and line numbers. This route is checked
against a real temporary manifest through the built-in tools and Agent gate.
Two files keep the recipe short; direct batching is also suitable for this small
case. Extend the pattern when many files or large metadata need reduction.

```javascript
const paths = ['package.json', 'packages/tools/package.json'];
const findings = await Promise.all(paths.map(async path => {
  try {
    const file = await tools.data('read', { path });
    if (file.truncated || file.raw_text === undefined) {
      throw new Error('Incomplete file');
    }
    const manifest = JSON.parse(file.raw_text);
    return { path, name: manifest.name, version: manifest.version };
  } catch (error) {
    return { path, error: error.message };
  }
}));
return findings;
```

Parallelize independent reads; keep dependent operations and mutations
sequential. Bound concurrency for large batches. Avoid logging raw results:
console output also reaches the model.
Nested tool results can themselves be previews with artifact paths. Read or
grep those artifacts selectively rather than parsing a preview as complete JSON.

Structured output has an 8 MiB serialized limit, a 64-level nesting limit, and
a 250,000-value limit. It rejects cycles, non-finite numbers, sparse arrays,
accessors, and non-JSON values. Absent optional object fields are omitted.
Content-changing result policies invalidate access to the earlier structured
value. If transfer, output validation, or a result policy fails after execution,
the tool may already have applied effects: inspect those effects before retrying
a mutation. Data access never causes an automatic second execution.

ToolFlow's byte diagnostics still measure rendered tool-result text and returned
script text. They do not count the execution-local canonical JSON transfer and
do not establish token, billing, or latency savings for structured mode.

The tool is directly available in the medium and off tiers. Other tiers can
discover it with `tool_search` and invoke it with `tool_use` when enabled.
The shared default, lite, and pro instructions describe both routes.

## Execution boundaries

The script runs in a QuickJS WebAssembly VM without filesystem, network,
process, or module access. Every nested tool call uses the normal agent gate
for validation, permissions, confirmation, hooks, and journaling. Discovery
does not grant execution permission. A script cannot invoke another script.

The default wall-clock limit is 120 seconds; `timeout_ms: 0` removes that
limit. Uninterrupted computation is still stopped after five seconds, and
the VM has a memory guard. `max_calls` optionally bounds tool calls.
Individual tools and enclosing gateways keep their own time limits; a script's
`timeout_ms` does not override them.
Stopping a script does not roll back effects or cancel already-started tools.
Await every tool call: returning while calls remain unfinished fails the script.
The context stays locked until already-started calls settle, including after an
abort or timeout, so another script cannot overlap those effects.

## Measured contribution

The real Agent/ToolExecutor runs six routes over the same 50 fixture reads.
Each read returns an ID and 11,000 characters of detail; the reduced answer is
`{ count: 50, sum: 1225 }`. A scripted provider controls the sequence, so this
checks execution and context routing, not a live model's tool choice or reasoning.

| Route | Provider requests | Fixture reads | Model result blocks | Model result text |
|---|---:|---:|---:|---:|
| Sequential direct calls | 51 | 50 | 50 | 551,040 B |
| Batched direct calls | 2 | 50 | 50 | 551,040 B |
| ToolFlow, direct | 2 | 50 | 1 | 120 B |
| ToolFlow through `tool_use`, schema already known | 2 | 50 | 1 | Under 400 B |
| Discover with `tool_search`, then `tool_use` | 3 | 50 | 2 | Under 2 KiB in this snapshot |
| ToolFlow returning all raw data | 2 | 50 | 1 preview | About 6.3 KiB, referencing a full artifact over 550 KB |

All request counts include the final answer request. Bytes count the actual
conversation tool-result bodies, including wrappers and diagnostics; they
exclude system prompts, schemas attached to requests, tool inputs, transport,
and journal storage. Each retained result body is counted once, not as cumulative
input across repeated provider requests. Discovery's schema result is included
in its result bytes. The fixture raises context/output caps to 2,000,000 to keep
the direct baseline intact; ordinary per-tool artifact handling remains enabled.
Deferred envelope size varies with `executionMs`; preview size varies with the
temporary artifact path. The [generated JSON snapshot](../website/src/data/toolflow-contribution.json)
contains the measured values and configuration.

The direct reduced answer is **over 99.9% smaller** than the batched fixture
result text. The batched and ToolFlow routes already use the same two provider
requests. Compared with a sequential tool loop, ToolFlow can remove intervening
model decisions when the next call can be determined in JavaScript. Discovery
adds a model request when the schema is not already known.

Returning raw data does not perform semantic reduction: the script produces
over 550 KB, and the existing executor saves it to an artifact and supplies a
preview. That preview is not the computed count/sum; further selective reads
may be needed. ToolFlow's useful distinction is computing the small answer
before the next model decision, while keeping each operation's gate and record.

## Choosing the right route

Prefer a tool's built-in filters or summary options when they already return
the answer. ToolFlow is useful when composing or reducing those results adds
something the individual tools do not provide.

| Need | Prefer | Reason |
|---|---|---|
| One simple operation | Direct tool call | Avoid interpreter and orchestration overhead |
| Independent calls with small outputs | Batched direct calls | Already avoids intermediate model requests |
| Repeated reads with filtering, joins, counts, or result-dependent calls | ToolFlow | Compute the next step and return compact findings inside the script |
| A reusable project-specific operation | Project Kit | Persist parameters, verification, and a revision-pinned implementation |
| A decision that needs model reasoning between steps | Direct calls between decisions | A deterministic script cannot replace that reasoning |

ToolFlow does not reduce the 50 underlying fixture reads, erase their journal,
or automatically shrink a raw return. Logs also enter context. QuickJS startup,
discovery, confirmations, and script errors can add work. The shared prompts
recommend appropriate use; tests do not establish that every live model follows
that guidance. Speed and cost depend on the workflow and provider and need
separate live measurements.

## Package boundary

`@wrongstack/toolflow` owns the interpreter, the QuickJS dependencies, and
the browser-safe `@wrongstack/toolflow/presentation` entry. The built-in
`tool_script` registration delegates to the package's declaration and executor.
ToolFlow initializes QuickJS on the first script run. The host tool gate still
validates, authorizes, and journals each nested call.

In a Quick session, use `/tool group toolflow on` or the ToolFlow setting in
WebUI Tools to enable discovery. Look up `tool_script` to load its schema for
the next request. The standalone WrongStack distribution includes the runtime
for this on-demand path.

## Reproduce the measurements

```powershell
$env:WRONGSTACK_TOOLFLOW_REPORT = '1'
bun --bun run vitest run packages/core/tests/core/nested-tool-call.test.ts
Remove-Item Env:\WRONGSTACK_TOOLFLOW_REPORT
```

With the flag, the suite writes `.reports/toolflow/contribution.json`,
`.reports/toolflow/contribution.md`, and the website's generated JSON snapshot.
Without it, tests do not update the snapshot. Fixture files and session journals
use isolated temporary directories. The normal executor writes the passthrough
artifact; the test verifies its size and removes only that fixture's artifact
afterwards. Temporary fixture directories are also cleaned up.
The suite also checks real manifest reads, disabled tools, schema validation,
and confirmation refusals. Run the broader ToolFlow checks with:

```powershell
bun --bun run vitest run packages/toolflow/tests packages/core/tests/core/nested-tool-call.test.ts packages/core/tests/core/shared-system-contract.test.ts
```

The broader tests cover byte accounting, aborts, unfinished effects, concurrent
script exclusion, and direct/deferred/unavailable prompt routes. UI render tests
check the brand, purpose, measurements, script inspection, and canonical-ID
settings toggles. These are not live browser, real-PTY, or live-model evaluations.
