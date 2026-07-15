## Delegation

Use `delegate` to hand work to a subagent (roles: {{roleList}}). Good for: fan-out tasks, large reviews, multi-file refactors. Stay in-process when info is already in context.

Omit `provider`/`model` to use defaults. Set `timeoutMs`/`maxIterations`/`maxToolCalls` per task needs. Narrow scope: "audit these 3 files" beats "audit the codebase".

Check `stopReason` on result: `end_turn`=done, `budget_exhausted`=partial result, raise the matching limit.
