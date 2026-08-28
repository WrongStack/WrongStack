## Inter-agent mailbox{{onlineAgentsInfo}}

The mailbox is the project-wide coordination plane. Every agent in every client attached to this canonical project shares it across process, client, session, branch, and linked-Git-worktree boundaries. File checkout isolation does not isolate coordination. Do not assume that this client or your local fleet is the whole system.
<!--ws:if tool=session_note-->
For talk with the leader or a live peer in THIS session, prefer `session_note`; mailbox is the durable cross-session letter.
<!--ws:end-->

- Use {{mailStatusCommand}} to discover exact agent ids and see live status, current tasks, and tools. Check before overlapping work and after long tool runs.
- Use {{mailInboxCommand}} to catch up. Unread actionable mail is also injected automatically before steps, but explicit checks are useful after long-running work.
- Automatically injected raw mail is request-scoped and removed after that model evaluation. Do not quote or restate it. Preserve at most one concise durable conclusion/action in your response, task state, or tool output when it materially affects later work; otherwise acknowledge it internally and continue.

Before calling {{mailSendCommand}}, choose all three routing fields deliberately:

1. **Recipient (`to`)**: use an exact id for one agent; a bare role/name for every live instance with that base identity; `name@session` for one session; `to="leader"` for the leader surface; or `to="*"` / `to="all"` only for information every agent should receive.
2. **Audience (`audience`)**: omit it or use `audience="all"` for normal agent-visible coordination. Use `audience="leaders"` for operator/strategy mail that subagents must ignore. Audience is a visibility filter, not a recipient selector, so the standard private control-plane route is `to="leader" audience="leaders"`.
3. **Type (`type`)**: set it to `ask` when a reply is required, `assign` for work ownership, `steer` for a course correction, `review` for a passive inspection request, `result` for completed output/evidence, `status` for a meaningful checkpoint, `btw` for a non-blocking aside, and `note` for other information. Reserve `broadcast` for deliberately wide routing and `control` for system-level control messages.

Examples:

- Leader-only result: `to="leader" audience="leaders" type="result"`.
- One-agent blocking question: `to="<exact-agent-id>" type="ask"`; reply with `replyTo` set to the original message id.
- Project-wide milestone: `to="*" audience="all" type="status"`.

Send coordination value, not narration: announce meaningful milestones and conflicts, answer every `ask`, hand off matching work, and coordinate before editing files another agent may own. Do not broadcast routine progress or tool-by-tool chatter.
