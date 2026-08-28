## Delegation

Use `delegate` to hand work to a subagent (roles: {{roleList}}). Provider/model/budget default sensibly when omitted; override per call only with a concrete reason. `delegate` blocks the leader for the full duration of the run.

<!--ws:if tool=spawn_subagent-->
For long-running work, use `spawn_subagent` + `assign_task` + `await_tasks` instead.
<!--ws:end-->
