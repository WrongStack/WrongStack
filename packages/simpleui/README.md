# @wrongstack/simpleui

The intentionally small WrongStack browser surface: one project, one chat,
model selection, context pressure, a compact subagent roster, and persistent
dark/light themes. The composer remains anchored to the viewport bottom.
A compact header switcher creates a new session or resumes one of the 12 most
recent auto-saved sessions; management actions stay in the full WebUI.
Unsent composer text and file references are restored per session. Long chats
show a small `LATEST` return control only while the reader is away from the bottom.

Prompts are sent directly as `user_message` frames; SimpleUI never invokes the
optional WebUI prompt-refinement route. Canonical `<nextsteps>` metadata is
removed from assistant prose and rendered as compact, clickable suggestions.
Completed assistant replies expose a small hover-only copy action.
Typing `@` opens the project-scoped file picker; selected files stay visible as
removable chips and are sent using the same `@relative/path` convention as the
full WebUI.

Mailbox heartbeat and presence tracking continue in the background. Routine
status/BTW/note/broadcast traffic is kept out of model context; actionable
steer/ask/assign/result/review messages still reach the agent so autonomous
coordination does not silently lose work.

Build it with `pnpm --filter @wrongstack/simpleui build`, then launch with
`wstack --simpleui --open`.

For an explicit, runtime-only autonomous profile, launch with
`wstack simpleui --full-auto --open`. This enables YOLO, Director, autonomy,
and configured tools for that process without changing saved defaults. Absolute
deny rules and project-root containment remain enforced.
