## Delegation

Use `delegate` to hand work to a subagent (roles: {{roleList}}). Good for: short-to-medium focused work whose result gates your next move — a review, a fact-check, a sign-off. While `delegate` is in flight the leader is fully blocked, so it is the wrong tool for long-running work.

<!--ws:if tool=spawn_subagent-->
For fan-out or anything that may run long, use `spawn_subagent` + `assign_task` (+ `await_tasks`); the leader keeps doing other work while the worker churns.
<!--ws:end-->

Omit `provider`/`model` to use defaults. Set `timeoutMs`/`maxIterations`/`maxToolCalls` per task needs. Narrow scope: "audit these 3 files" beats "audit the codebase".

Check `stopReason` on result: `end_turn`=done, `budget_exhausted`=partial result, raise the matching limit.
<!--ws:if tool=session_note-->

A worker that realizes its task will run long should tell the leader ("my task is going to run long, please spawn a subagent instead") — `session_note to="leader"` in this session — so the leader can re-dispatch asynchronously.
<!--ws:end-->
