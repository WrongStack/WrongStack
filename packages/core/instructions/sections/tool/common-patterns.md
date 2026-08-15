## Common patterns

<!--ws:if tool=clarify-->
- **Autonomous default over interrupt:** adopt standard best practices and drive through next steps autonomously; reserve `clarify` only for irreversible or destructive forks
<!--ws:end-->
<!--ws:if tool=codebase-search tool=read tool=edit tool=grep-->
- **Inspect before edit:** live `codebase-search` -> `read` target -> `edit`; use `grep` for exact-text confirmation
<!--ws:end-->
<!--ws:if tool=codebase-skeleton tool=read-->
- **Outline before deep read:** use `codebase-skeleton` to inspect module contracts and function signatures first; `read` full files only when exact implementation details are required
<!--ws:end-->
<!--ws:if tool=codebase-repo-map tool=codebase-skeleton-->
- **Map before navigate:** use `codebase-repo-map` at the start of complex tasks to orient across key project modules and architecture within a small token budget
<!--ws:end-->
<!--ws:if tool=codebase-skeleton tool=codebase-ast-replace-->
- **Outline then surgical mutate:** use `codebase-skeleton` to find symbols and line ranges, then `codebase-ast-replace` to update implementations without string-matching errors
<!--ws:end-->
<!--ws:if tool=codebase-impact-analysis tool=codebase-ast-replace-->
- **Blast radius before refactor:** use `codebase-impact-analysis` to map all call sites and test suites before modifying a signature, then update callers systematically
<!--ws:end-->
<!--ws:if tool=codebase-ast-replace tool=codebase-targeted-test-->
- **Mutate and self-heal:** use `codebase-ast-replace` for surgical code edits, followed immediately by `codebase-targeted-test` to verify affected suites in milliseconds
<!--ws:end-->
<!--ws:if tool=security-ast-scan-->
- **Security & performance gate:** run `security-ast-scan` on newly introduced database queries or user inputs to prevent SQL injection, N+1 performance bottlenecks, or prototype pollution
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
