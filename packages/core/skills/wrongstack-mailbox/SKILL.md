---
name: wrongstack-mailbox
description: |
  Use this skill when the user wants to communicate with WrongStack's
  shared project mailbox from outside WrongStack — read messages sent
  by WrongStack agents, send replies, broadcast to all, or stay visible
  as an online agent. Triggers: user says "check the WrongStack
  mailbox", "send to WrongStack", "wrongstack mail", "broadcast to the
  fleet", "tell the wrongstack agents", "is anyone online in
  wrongstack", or "register me with wrongstack".
version: 1.0.0
---

# WrongStack Mailbox Client

> **External-facing skill.** Bundled with `@wrongstack/core` so it can
> be shipped to external agents via `scripts/install-mailbox-bridge-skills.sh`
> (which copies this file into the agent's local skills directory, e.g.
> `.claude/skills/wrongstack-mailbox/SKILL.md`). It is **not** for
> WrongStack's own REPL/TUI/WebUI — WrongStack agents should use the
> `mailbox` tool and the bundled `mailbox-bridge` skill instead.

Connect to a WrongStack project's shared inter-agent mailbox from
outside WrongStack. Read what internal agents are saying, send replies,
broadcast, and stay visible as an online agent in their WebUI.

This skill is the **external-facing** counterpart to the
`mailbox-bridge` skill that runs inside WrongStack. The two are
designed to be installed as a pair: `mailbox-bridge` on the WrongStack
side starts the HTTP server; this skill teaches you (the external
agent) how to talk to it.

## What this skill assumes

- A WrongStack user is already running `wstack mailbox serve` in the
  project. Confirm with the user before assuming the bridge is up.
- Two environment variables are set:
  - `WRONGSTACK_MAILBOX_URL` — e.g. `http://127.0.0.1:34827`
  - `WRONGSTACK_MAILBOX_TOKEN` — the bearer token from
    `~/.wrongstack/projects/<slug>/.mailbox.token`

If either is missing, **stop and ask the user**. Do not invent a URL or
token, and do not assume defaults — a wrong token returns 401 and a
wrong URL returns connection-refused, both of which are easy to
misdiagnose.

## When to use this skill

- The user asks you to read what's in the WrongStack mailbox.
- The user asks you to send a message to a specific WrongStack agent or
  to everyone (`broadcast`).
- The user wants you to register so WrongStack's WebUI shows you as an
  online external agent.
- The user wants you to reply to a specific message (look up the
  `replyTo` chain).

## When NOT to use this skill

- The user wants the *full* WrongStack tool surface (file edits, shell,
  git, etc.). The bridge exposes **only mailbox operations**. For
  everything else, run WrongStack itself or use its MCP server.
- The user wants SMTP / IMAP / email integration. The WrongStack mailbox
  is internal-to-WrongStack — not an email server. Push back.
- The bridge is not running. Verify with `GET /healthz` before doing
  anything else.

## Connection model

Single bearer token in `Authorization: Bearer <token>` on every
request. The token is rotated every time the bridge starts; read it
freshly from the token file or accept it from the user — never hardcode
it into prompts or committed code.

```ts
const URL = process.env.WRONGSTACK_MAILBOX_URL;
const TOKEN = process.env.WRONGSTACK_MAILBOX_TOKEN;

if (!URL || !TOKEN) {
  throw new Error(
    'WRONGSTACK_MAILBOX_URL and WRONGSTACK_MAILBOX_TOKEN must be set ' +
    'before talking to the WrongStack mailbox bridge. Ask the user to ' +
    'run `wstack mailbox serve` and pass you the printed URL + token.',
  );
}
```

## The single helper

Everything in this skill goes through one fetch helper. Copy it once,
use it for every route. It enforces the bearer token, sends JSON on
POST, parses JSON on the response, throws on non-2xx, and applies a
timeout so a hung bridge can't wedge the agent.

```ts
async function mb(path: string, body?: unknown): Promise<unknown> {
  const url = `${process.env.WRONGSTACK_MAILBOX_URL}${path}`;
  const token = process.env.WRONGSTACK_MAILBOX_TOKEN;
  const res = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const errBody = await res.json() as { error?: { code?: string; message?: string } };
      if (errBody.error) {
        detail = `${errBody.error.code ?? 'ERROR'}: ${errBody.error.message ?? '(no message)'}`;
      }
    } catch {
      detail = await res.text().catch(() => '(no body)');
    }
    throw new Error(`wrongstack mailbox ${res.status} ${detail}`);
  }
  return res.json();
}
```

Always use `AbortSignal.timeout` — never let a request hang forever.
The mailbox is local; 10 s is generous.

## Patterns

### Pick a stable agent id

If you're going to register, pick a stable `agentId` you can reuse
across sessions (so the WebUI can show your read history). Convention:

```
claude-code-<pid>-<short-hostname>
```

or any unique-enough string. **Do not** randomize per call — read
receipts break if your `agentId` changes every poll.

### Register once, then heartbeat

Register before you do anything else. Then run a heartbeat every 30 s
while you're alive; without it, you flip to "offline" after 60 s and
the WebUI hides you.

```ts
const agentId = process.env.WRONGSTACK_AGENT_ID
  ?? `claude-code-${process.pid}`;

await mb('/mailbox/agents/register', {
  agentId,
  sessionId: 'external',
  name: 'Claude Code',
  role: 'external',
  pid: process.pid,
});

// Then, while alive:
setInterval(() => {
  mb('/mailbox/agents/heartbeat', {
    agentId,
    currentTask: '<one-line description of what you're doing>',
  }).catch(() => { /* heartbeat is best-effort */ });
}, 30_000);
```

### Poll, don't long-poll

The bridge does not support long-polling or websockets. Poll for new
messages on a 5–10 s interval using the `since` filter. Don't poll
faster than 1 Hz — that's noisy and gives nothing useful.

```ts
let lastSeen: string | undefined;

async function pollOnce(): Promise<void> {
  const args: Record<string, unknown> = {
    to: agentId,             // mail addressed to me
    incompleteOnly: true,    // only work I haven't finished
    limit: 50,
  };
  if (lastSeen !== undefined) args['since'] = lastSeen;
  const result = await mb('/mailbox/query', args) as { data: MailboxMessage[] };

  for (const m of result.data) {
    console.log(`[${m.type}] from=${m.from} subject=${m.subject}`);
    // ...handle the message...
    await mb('/mailbox/ack', {
      messageId: m.id,
      readerId: agentId,
      read: true,
    });
  }
  if (result.data.length > 0) {
    lastSeen = result.data[result.data.length - 1]!.timestamp;
  }
}

setInterval(pollOnce, 5_000);
```

### Reply with `replyTo`

Set `replyTo` to the id of the message you're replying to. The original
sender's client will then thread your reply to their message. Without
`replyTo`, your reply is a freestanding message and the sender has to
match by subject.

```ts
await mb('/mailbox/send', {
  from: agentId,
  to: originalMessage.from,
  type: 'result',
  subject: `Re: ${originalMessage.subject}`,
  body: '<your response>',
  replyTo: originalMessage.id,
});
```

### Ack in batches

If you've just consumed a backlog, don't ack them one at a time. Use
`/mailbox/ack-many` — one HTTP request, one file-lock acquisition, one
JSONL rewrite inside WrongStack:

```ts
await mb('/mailbox/ack-many', {
  acks: messages.map((m) => ({
    messageId: m.id,
    readerId: agentId,
    read: true,
    completed: true,
    outcome: 'handled',
  })),
});
```

Prefer this over per-message `/mailbox/ack` whenever you have more than
one unread message.

### Broadcast with `to: "*"`

`to: "*"` (or `"all"`) reaches every online agent. Use sparingly — the
internal WebUI marks broadcasts with a different color and humans
notice noise. A reasonable rule: at most one broadcast per task, and
always with a clear subject so people can mute it mentally.

```ts
await mb('/mailbox/send', {
  from: agentId,
  to: '*',
  type: 'note',
  subject: 'Claude Code: starting security audit',
  body: 'Will report findings via /mailbox/send directed at leader@…',
});
```

## Message types

Pick the type that matches the **intent** of your message. WrongStack
agents read `type` to decide how urgently to handle it.

| Type | When to use |
|------|-------------|
| `note` | Informational; no action expected. |
| `ask` | You have a question and want an answer. |
| `assign` | You're delegating a task. Provide `taskContext`. |
| `steer` | Mid-task change of direction. Use sparingly. |
| `btw` | "By the way" — non-urgent info the recipient may want later. |
| `broadcast` | Sent to `*`. Everyone sees it. |
| `status` | Self-report ("I'm working on X"). |
| `result` | You're reporting the outcome of a task. Often a `replyTo`. |
| `control` | Out-of-band signal. Don't use unless you know what you're doing. |

## Routes reference

All routes take JSON bodies on POST (or no body on GET). All require
`Authorization: Bearer <token>`. Responses are JSON.

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/mailbox/send` | Send a message |
| POST | `/mailbox/query` | Query messages (filters: `to`, `from`, `unreadBy`, `type`, `minPriority`, `incompleteOnly`, `limit`, `since`) |
| POST | `/mailbox/ack` | Acknowledge one message |
| POST | `/mailbox/ack-many` | Acknowledge many in one batch |
| POST | `/mailbox/unread-count` | Count unread for an agent |
| POST | `/mailbox/agents/register` | Register this external agent |
| POST | `/mailbox/agents/heartbeat` | Update agent heartbeat |
| POST | `/mailbox/register-client` | Register this external client (different from agent — for session-level liveness) |
| POST | `/mailbox/heartbeat` | Update client heartbeat |
| GET | `/mailbox/agents` | List all registered agents |
| GET | `/mailbox/agents/online` | List agents with a live heartbeat (within 60 s) |
| GET | `/healthz` | Liveness probe — does NOT require auth |

### Error shape

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "field \"from\" is required (string)" } }
```

| Code | HTTP | What it means / what to do |
|------|------|----------------------------|
| `VALIDATION_ERROR` | 400 | Missing or wrong-type field. Read the message; it tells you which field. |
| `UNAUTHORIZED` | 401 | Token mismatch. Re-read `~/.wrongstack/projects/<slug>/.mailbox.token` and try again — the bridge may have restarted. |
| `NOT_FOUND` | 404 | Wrong route. Check the path table above. |
| `INTERNAL_ERROR` | 500 | WrongStack-side failure. Retry once; if it persists, surface to the user. |

## Recipes

### "Is anyone online?"

```ts
const result = await mb('/mailbox/agents/online') as { data: AgentStatus[] };
console.log(`${result.data.length} agent(s) online:`);
for (const a of result.data) {
  console.log(`  ${a.agentId}  ${a.status}  ${a.currentTask ?? '(idle)'}`);
}
```

### "Read my inbox"

```ts
const result = await mb('/mailbox/query', {
  to: agentId,
  unreadBy: agentId,
  incompleteOnly: true,
  limit: 20,
}) as { data: MailboxMessage[] };
for (const m of result.data) {
  console.log(`[${m.type}] ${m.from}: ${m.subject}`);
  console.log(`  ${m.body}`);
}
```

### "Reply to the most recent message directed at me"

```ts
const { data: messages } = await mb('/mailbox/query', {
  to: agentId,
  incompleteOnly: true,
  limit: 1,
}) as { data: MailboxMessage[] };
const latest = messages[0];
if (!latest) return;

await mb('/mailbox/send', {
  from: agentId,
  to: latest.from,
  type: 'result',
  subject: `Re: ${latest.subject}`,
  body: '<your reply>',
  replyTo: latest.id,
});
await mb('/mailbox/ack', {
  messageId: latest.id,
  readerId: agentId,
  read: true,
  completed: true,
});
```

### "Broadcast a status update"

```ts
await mb('/mailbox/send', {
  from: agentId,
  to: '*',
  type: 'status',
  subject: 'Claude Code: <one-line summary>',
  body: '<details>',
});
```

## Anti-patterns

- **Don't bypass the HTTP layer to read the JSONL directly.** The
  bridge exists so external agents don't have to honor the file-lock
  protocol. Reading the file directly can race with `GlobalMailbox.ack`
  rewrites and silently corrupt state.
- **Don't reuse one `agentId` across multiple external sessions.** If
  two processes register under the same id, heartbeats overwrite each
  other and read receipts become unreliable.
- **Don't poll faster than 1 Hz.** The bridge isn't load-tested for
  high-frequency polling, and there's no rate limit at the server side
  — your noisy client can starve other agents.
- **Don't include the token in any logged output.** It's the only
  credential. If you must print the URL, redact the token (`[REDACTED]`).
- **Don't reply to a broadcast with another broadcast.** Replies should
  target the original sender via `to: <their-id>`, with `replyTo` set.
- **Don't use `control` messages.** They go through a different path in
  the WrongStack agent loop and will likely be dropped on the floor by
  the recipient.

## Example: minimal end-to-end session

```ts
// 1. Confirm the bridge is up.
await mb('/healthz'); // throws if down

// 2. Pick a stable id and register.
const agentId = `claude-code-${process.pid}`;
await mb('/mailbox/agents/register', {
  agentId,
  sessionId: 'external',
  name: 'Claude Code',
  role: 'external',
  pid: process.pid,
});

// 3. Heartbeat every 30 s.
setInterval(() => {
  mb('/mailbox/agents/heartbeat', { agentId }).catch(() => undefined);
}, 30_000);

// 4. Poll for new mail every 5 s.
let lastSeen: string | undefined;
setInterval(async () => {
  try {
    const args: Record<string, unknown> = {
      to: agentId,
      incompleteOnly: true,
      limit: 50,
    };
    if (lastSeen !== undefined) args['since'] = lastSeen;
    const { data } = await mb('/mailbox/query', args) as { data: MailboxMessage[] };
    for (const m of data) {
      // ...your handling logic here...
      console.log(`[${m.type}] ${m.from}: ${m.subject}`);
    }
    if (data.length > 0) lastSeen = data[data.length - 1]!.timestamp;
  } catch (err) {
    console.error('mailbox poll failed:', (err as Error).message);
  }
}, 5_000);
```

This is the smallest viable integration. From here, the typical
extension is to **act on** the messages — call tools, write files, run
tests — and post results back via `/mailbox/send`.

## How this skill is shipped

This file is bundled inside `@wrongstack/core` at
`packages/core/skills/wrongstack-mailbox/SKILL.md` and exported via the
package's wildcard `./skills/*` export. To install it into an external
agent's project (e.g. Claude Code's `.claude/skills/`):

```sh
bash scripts/install-mailbox-bridge-skills.sh ~/.claude/skills
```

The script is **idempotent** — re-running overwrites existing copies
with the latest bundled version.

## Skills in scope

- `node-modern` — `AbortSignal.timeout`, ESM-only imports.
- `output-standards` — when reporting mailbox activity to the user,
  shape it as the project's standard output.
- `prompt-engineering` — when composing `subject`/`body` text that
  other agents will read, keep it specific and short.