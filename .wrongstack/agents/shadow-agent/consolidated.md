## Signal Classification

- When the host reason enumerates a batch of subagent failures (e.g. `zai-coding-plan HTTP 429`), treat them as historical context, not in-flight anomalies. Verify liveness via `fleet status`/`health` before classifying any subagent as down.
- A `mail_inbox` full of peer `status` broadcasts is informational noise. Only `type=control` messages or bodies starting with `hoop`/`shadow` warrant a reply.
- Never broadcast a summary of routine fleet mail.