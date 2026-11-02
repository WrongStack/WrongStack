# Tool governance

Tool contracts describe behavior; the host permission policy authorizes each actual
call. A capability, icon, cost hint or MCP annotation never grants permission.

## Sources and checks

- `packages/tools/src/builtin.ts` owns executable built-ins and their provider descriptions.
- `ToolRegistry.exportCatalog()` projects the current enabled registry, including late
  plugin and MCP registrations. `wstack tools catalog --json` exports this snapshot;
  `--check` returns a nonzero exit code for declaration issues. Exporting metadata
  does not make session-bound tools callable from the external CLI.
- WebUI clients can request the same active-host projection with
  `tools.list` and `payload: { catalog: true, requestId }`. Ordinary tool-list
  responses remain compact. The export includes late plugin/MCP registrations
  present in that host, unlike the standalone built-in snapshot.
- `architecture/tool-catalog.json` is a generated **built-in** snapshot. It is not a
  claim about every tool a configurable host can load. Website contracts and the
  generated [reference](tool-reference.md) use the same catalog projection. Display
  categories and editorial website notes remain presentation data.
- `packages/tools/src/tool-icons.ts` owns visual identity and colors. The old
  `tool-icon-map.ts` entry point re-exports it. Unknown third-party tools retain a
  fallback; shipped built-ins must have an identity.
- `bun run tools:catalog:check` validates built-in declarations, generated files,
  selection coverage and schema budgets. CI also runs the website drift checker.
  Run `bun run tools:catalog:write` after intentional contract changes, then
  `bun run website:tools:write` if website projections changed.

## Permissions and review

New tools must declare their actual effects, including indirect filesystem writes,
command execution, paid fan-out and persistent configuration changes. An `auto`
declaration with `shell.*`, `fs.write*`, fleet mutation or a destructive risk tier
fails the built-in declaration gate. Fleet reads are not fleet mutations.

Before approving an exception, record its exact tool and owner, capabilities,
reason, bounded effects, host gate and regression tests in this document. There
are **no built-in auto-mutation exceptions**. Third-party declarations are untrusted:
review the registered-host export and apply the host's policy; do not accept a
matching tool name as an execution exemption.

The Director registry has one reviewed capability exception: `fleet_emit` remains
`auto` with exactly `coordination.fleet.emit` and `mutating: false`. It publishes
attributed, schema-checked in-process events; it grants no filesystem or command
capability. The whole Director toolset test pins these bounds. Raw registry
diagnostics still identify this capability for review. No exception covers extra
capabilities, fleet termination or persistent task writes.

Use `deny` for an operation the current host or operator prohibits. Use `confirm`
for an allowed operation requiring a decision on its actual target and input.
The number of denied tools is not a safety score. `mutating` records effects and
does not replace capabilities or the per-call permission decision. YOLO and YOLO+
retain their existing, separately tested authorization semantics; a metadata risk
tier is not a new unconditional prohibition.

A tool's hard default `deny` wins over queued one-shot approvals in every autonomy
mode. `evaluate()` and `explain()` apply the same ordering.

`tool_use` and `tool_script` retain the managed nested execution path. Each child
keeps validation, hooks, permission checks, confirmation and journaling. The
legacy outer `tool_use` confirmation remains; this change does not remove an
authorization boundary merely to reduce prompts. Never call a target's `execute`
directly from a gateway. Apply permission checks after hook input rewriting.

## Aliases and deprecation

`Tool.aliases` lists names with **identical input and output semantics**. The registry
resolves them to the canonical tool before reachability, hooks and policy checks.
Aliases add no provider schemas. Discovery returns the canonical name and lifecycle
metadata. A collision with another name or alias fails registration atomically.
ToolFlow preserves both `tools.call(oldName, input)` and callable old-name members;
`tools.names()` lists canonical identities once. External gateway lookup resolves
aliases only inside its permitted exposed set.
Shipped aliases must also retain a matching entry in the shared icon map; the
built-in visual-identity gate checks this when an alias is added.
An alias cannot bypass a disabled tool, a launch restriction or a denied canonical
tool. Old-name persistent and session denials remain restrictive; old-name grants
do not become new canonical grants automatically.

An adapter is required when schemas differ. Similar descriptions, capability-manifest
nicknames and MCP tool names are not proof of input compatibility.

For a replacement:

1. Add an alias for an identical contract, or keep an explicit tested adapter for a
   changed contract. Preserve permissions, capabilities, side effects and errors.
2. Set `deprecated: { since, replacedBy, removeAfter }` on the old tool. Keep the old
   executable entry for **at least two minor releases** and announce the migration.
3. Observe explicit journal samples across the migration window. Preserve the
   requested name in journals so old callers can be distinguished. No observations
   in a sample do not prove global non-use.
4. Remove the old executable entry only after reviewed evidence, release notes and
   caller migration. Keep discoverable aliases where semantics are identical.
5. Ship one family per independently reversible change. Test direct, gateway and
   ToolFlow calls, disabled/denied targets and old/new inputs before removal.

No existing tool names are removed or merged by this foundation change.

## Choosing a tool

| Need | Selection boundary |
| --- | --- |
| Compact active work list | `todo`; use `kanban` for persistent cards, dependencies and assignments. |
| An implementation plan | `plan`; it does not replace the state of a task board. |
| Fleet work dispatch | `assign_task` or `kanban_queue`; inspect `fleet`/`fleet_status` for worker state. |
| Same-session agent note | `session_note`; use `mail_send`/`mail_inbox` for cross-session project mail. |
| Ordinary project memory lookup | `search_memory`; select graph, file-context, SAGE or vector tools according to their registered backend contract. They are not interchangeable stores. |
| HTTP response or API payload | `fetch`; use `read_url_content` for extracted readable page content. Preserve their distinct response, credential and network policies in any future adapter. |
| A specific subsystem's state | Its existing status tool. An aggregate status must retain source, timestamp and unavailable/error state for every component. |
| Deterministic dependent tool work | `tool_script`; direct calls remain appropriate for a simple operation. Every child is still governed. |

## Schema economics

`architecture/tool-schema-budget.json` caps count, UTF-8 bytes and runtime-estimated
tokens for each built-in tier and the actual six-tool lean benchmark roster. The
probe uses `compactToolDefinitionForWire`, the same projection used in runtime
accounting. These are schema estimates, not billed tokens: provider wrappers,
system prompts, runtime additions and tokenizer differences are outside this
built-in budget. Lean imports its names from the benchmark implementation.

Host-only aliases, cost, prerequisites, lifecycle metadata and usage hints are
excluded from provider schemas. Four existing long descriptions have individually
bounded, documented exceptions in the generator; all other descriptions are capped
at 300 characters. Do not blindly truncate safety guidance to meet a target.
Budgets never grow as a side effect of catalog generation. An intentional reviewed
reset requires `bun scripts/generate-tool-catalog.ts --write --adopt-budget`.

## Usage evidence and merge sequence

The existing event bridge and Chronicle remain the collection paths. The in-process
usage map counts each settled call once; start events have their own metric.

To inspect an explicit, local sample without uploading raw journals:

```sh
wstack tools catalog --json > catalog.json
bun run tools:usage:report --catalog catalog.json --journal session-a.jsonl --journal session-b.jsonl --from 2026-10-01 --to 2026-12-31T23:59:59.999Z
```

The report emits canonical tool counts, failures, session counts, last use and sample
coverage. It does not emit arguments or result contents. Duplicate result IDs are
counted once per journal; unsettled and unrecognized calls are reported separately.
Core audit journals omit standalone `tool_use` rows. Their assistant message and
LLM-response blocks supply call identities; explicit call records take precedence.
Use one journal per session. `not-observed` is a sample statement, never an automatic
removal decision. Existing external MCP metric labels remain aggregated to avoid
exposing user-controlled server names.

At each minor release, review the generated snapshot diff for names, capabilities,
permissions, descriptions, icons and schemas. Produce a quarterly usage report from
an explicitly selected observation window before proposing consolidation.

Evaluate one family at a time: mailbox convenience routing; fleet status; HTTP
content retrieval; memory backend selection; then subsystem status aggregation.
For each, require measured use and failure data, a semantic contract comparison,
permission parity, a tested adapter and a rollback step. Status tools and memory
searches must not be collapsed solely because their names resemble each other.

## Output contract migration

`ToolSettlement` already records execution outcomes, `ToolErrorCategory` classifies
errors, and `outputSchema` plus `programmaticOutput` support validated structured
ToolFlow results. Extend these existing contracts incrementally. Do not rewrite
every text serializer into a universal envelope in the same change.

Domain recovery codes such as `NEEDS_INDEX` or `ORIGIN_BLOCKED` belong in reviewed
output schemas with actionable next steps. A new code needs a real failing case and
compatible text output. A timeout does not establish whether a mutation completed;
only tools explicitly declaring `retrySafe` may be considered for a future automatic
retry policy. The new hint itself does not enable retries.

Remaining migrations require separate behavior evidence: domain error codes,
uniform truncation metadata, a blocker/status aggregate, populated prerequisites,
family-specific selection requirements, live usage-driven tier changes and actual
tool merges. The foundation does not claim those migrations have shipped.

## Initial usage sample (2026-10-31)

The [local sample](../reports/tool-usage-sample-2026-10-31.json) covers 20 stable
WrongStack journals in the October window: 1,663 settled calls, 13 observed tool
names and zero unrecognized results after core-audit reconstruction. The six lean
tools account for 1,525 calls (91.7%). This is a recent-session sample, not a
representative benchmark or a complete quarterly report. Its name inventory comes
from the supplied audit snapshot plus current built-ins, not a fresh live host.

None of the proposed work-tracker, HTTP-content, fleet-status or memory-search
merge families has enough observed use in this sample to validate a replacement.
Preserve their existing contracts. Before changing the direct tier, stratify by
task and exposed provider roster: a tool absent from a request cannot be selected,
so low use alone cannot establish that it is unnecessary. The immediate shipped
control is the measured schema budget; actual merges and tier changes remain
conditional on that additional behavior evidence.
