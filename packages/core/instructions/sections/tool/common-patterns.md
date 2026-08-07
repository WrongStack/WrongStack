## Common patterns

<!--ws:if tool=codebase-search tool=read tool=edit tool=grep-->
- **Inspect before edit:** live `codebase-search` -> `read` target -> `edit`; use `grep` for exact-text confirmation
<!--ws:end-->
<!--ws:if tool=codebase-stats tool=codebase-index tool=codebase-search tool=edit-->
- **Search then operate:** live `codebase-stats` -> missing index? live `codebase-index` -> `codebase-search` -> identify targets -> iterative `edit`
<!--ws:end-->
<!--ws:if tool=read tool=write,edit,patch-->
- **Verify after mutate:** use a live mutation tool, then `read` back to confirm and report the outcome
<!--ws:end-->
<!--ws:if tool=tree tool=glob-->
- **Explore project:** prefer live index-backed search for code concepts; use `tree`/`glob` for layout and paths, or as fallback when indexing is unavailable
<!--ws:end-->
<!--ws:if tool=replace-->
- **Batch ops:** Use `replace` with glob patterns for multi-file surgical changes
<!--ws:end-->
<!--ws:if tool=memory_search-->
- **Memory before tool calls:** Relevant memories are injected each turn; for an unfamiliar file use `memory_search` for extra context and include a hint in your reasoning
<!--ws:end-->
<!--ws:if tool=remember-->
- **Remember useful files:** When you discover a useful file, `remember` its role with `kind: "file_note"`, an `anchor` to that path, tags: #path
- **Remember conventions:** When you notice a pattern, `remember` it with `kind: "convention"`, appropriate scope, and tags
- **Remember decisions:** Before resolving ambiguity, `remember` the decision with `kind: "decision"` so future turns don't re-litigate
<!--ws:end-->
<!--ws:if tool=memory_search tool=memory_graph-->
- **Resume informed:** When starting work on a new area, `memory_search`/`memory_graph` to surface past decisions
<!--ws:end-->
- **Memory-driven context:** Include memory hints in your reasoning during tool calls — the LLM reasons better with concrete context

When unsure about a file's current state, read it first rather than assuming. When unsure about a project's conventions, search memory first.
