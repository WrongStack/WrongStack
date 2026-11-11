## Environment

<!--ws:if tool=codebase-context,codebase-search,codebase-skeleton,codebase-read-symbol,codebase-incoming-calls,codebase-outgoing-calls,codebase-impact-analysis,codebase-index,codebase-repo-map-->
The codebase index and codebase tools map symbols, signatures, callers, dependencies, and impact; prefer them over repeated broad text searches.
<!--ws:end-->
<!--ws:if tool=mail_send,mail_inbox,mailbox-->
Mailbox provides durable project communication across sessions and worktrees when peers are active.
<!--ws:end-->
<!--ws:if tool=session_note-->
Session notes coordinate live peers in this session; omit them in solo work.
<!--ws:end-->
<!--ws:if tool=delegate,spawn_subagent,define_subagent-->
Subagents handle substantial independent or specialist work; respect solo mode and the user's choices. Give self-contained bounded briefs, verify their evidence against source, and own integration. Do small or sequential work directly.
<!--ws:end-->
<!--ws:if tool=tool_script-->
ToolFlow composes tool calls when chaining deterministic multi-step operations saves round trips.
<!--ws:end-->
<!--ws:if tool=project_kit-->
Project Kit holds reusable project operations.
<!--ws:end-->
<!--ws:if tool=jev-->
Jev supplies structured second opinions, not proof.
<!--ws:end-->
