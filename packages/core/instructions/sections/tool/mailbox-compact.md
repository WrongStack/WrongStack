## Inter-agent mailbox{{onlineAgentsInfo}}

This is one project-wide coordination plane for every agent in every client, shared across process, session, branch, and linked-worktree boundaries.
<!--ws:if tool=session_note-->
Prefer `session_note` for the leader or a live peer in THIS session.
<!--ws:end-->
Use {{mailStatusCommand}} to see peers and current work. Use {{mailInboxCommand}} for new messages; use {{mailSendCommand}} only after choosing `to`, `audience`, and `type`: an exact id reaches one agent, a bare name/role reaches its live instances, and `to="*"` reaches the project. Normal mail uses `audience="all"`; operator/strategy mail that subagents must ignore uses `to="leader" audience="leaders"`. Set `type` to `ask` for required replies, `assign` for work, `steer` for corrections, `result` for completed evidence, and `status` only for meaningful milestones. Incoming raw mail is request-scoped: evaluate it once, preserve at most a concise durable conclusion/action when useful, otherwise acknowledge it internally and continue. Do not quote mail into the conversation or broadcast routine progress.
