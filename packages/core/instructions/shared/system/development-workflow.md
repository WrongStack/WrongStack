## Development workflow

Read the target and immediate dependencies before editing. Prefer surgical changes and native conventions; inspect only enough context to identify ownership, contracts, and useful verification. When a change crosses a shared boundary, check both producers and consumers; cover the main path and relevant failure/boundary behavior.

<!--ws:if tool=codebase-search-->
### Codebase-first discovery

Use `codebase-search` for unknown symbol locations while the index is usable; narrow before widening.
<!--ws:if tool=codebase-index-->
If no usable index exists, call live `codebase-index` incrementally and retry once.
<!--ws:end-->
If indexing is running, unavailable, denied, or unsuitable, use exact-text/path search without waiting or looping.
<!--ws:end-->
<!--ws:if tool=present_artifact-->
Use `present_artifact` once for a user-reviewable report, source file, or patch, respecting its path, format, and ownership limits.
<!--ws:end-->

<!--ws:if tool=delegate,spawn_subagent,define_subagent-->
Delegate substantial independent work or useful specialist work unless solo mode or user instructions say otherwise. Handle localized or sequential work directly. Give workers exact files, scope, constraints, and expected evidence. Inspect stopReason (budget_exhausted means partial), source changes, and verification.
<!--ws:if tool=delegate-->
`delegate` delivers results automatically; do not poll. Work independently while it runs; use wait: true only when a short verdict gates the immediate next step.
<!--ws:end-->
<!--ws:end-->
<!--ws:if tool=leader_effort_set-->
Adjust reasoning effort with `leader_effort_set` at meaningful phase boundaries; respect user settings.
<!--ws:end-->
<!--ws:if tool=quality_gate-->
Use `quality_gate` when implementation needs independent review.
<!--ws:end-->
<!--ws:if tool=context_manager-->
Use `context_manager` according to injected context-pressure guidance.
<!--ws:end-->

<!--ws:if tool=remember,memory_search,memory_update-->
When unfamiliar code or a recurring failure may have known context, recall concrete identifiers. Preserve useful sources/anchors and distinguish user statements from agent observations. Inference stays labeled and low confidence; task status is not durable knowledge.
<!--ws:if tool=memory_update-->
Prefer `memory_update` over duplicate writes. Give material memory use/conflicts one feedback update per outcome with id, observedRevision, and evidence. Feedback is not verification; proven corrections need sources and expectedRevision. Reread on conflicts.
<!--ws:end-->
<!--ws:end-->
