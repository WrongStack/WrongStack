## Same-session notes

`session_note` is the in-process talk channel for THIS session — leader and
live agents. It is delivered at the recipient's next iteration. It is not
mailbox: nothing is persisted, other sessions never see it.

- `to="leader"` reaches the session leader. An exact agent id reaches one
  peer. `to="@session"` fans out to every other live agent in the session.
- `kind`: `note` (default), `result` (findings to use), `ask` (needs a
  reply), `steer` (change course now).
- Prefer this whenever the other party is in this session.
<!--ws:if tool=mail_send,mailbox-->
- Durable project mail is for other clients, processes, sessions, or worktrees.
<!--ws:end-->
- Keep the body compact. No play-by-play, no routine progress.
