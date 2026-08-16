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
version: 1.1.0
required-capabilities: []
required-tools: [mailbox]
optional-capabilities: [mcp.dynamic, web.research]
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

Since commit `46427ea4` (feat/mailbox-daemon), every WrongStack
surface (REPL/TUI/WebUI/eternal-autonomy) **auto-bootstraps** the mailbox
bridge on startup. The first surface to come up for a given project
joins an existing instance or spawns a fresh `wstack mailbox serve`
child process; a second surface on the same project joins the first's
bridge rather than spawning a duplicate. The per-project lock
(`.mailbox-bridge.lock`) and token file (`.mailbox.token`) make
discovery trivial.

So the realistic scenarios for an external agent are:

1. **A WrongStack surface is already running for the project** (most
   common). Read the bridge URL + token from the per-project files —
   no env vars, no manual `wstack mailbox serve`, no user prompt.
2. **No WrongStack surface is running, but `wstack` is on PATH.**
   `mbWithBootstrap()` (see Patterns below) spawns the bridge itself
   for the duration of the agent's session and cleans up at exit.
3. **Nothing is running and `wstack` is NOT on PATH.** Fall back to
   asking the user to start a surface (`wstack --repl`,
   `wstack --webui`) or to run `wstack mailbox serve` manually.

Environment variables (`WRONGSTACK_MAILBOX_URL`,
`WRONGSTACK_MAILBOX_TOKEN`) still work as overrides — useful for
pointing at a non-default bridge (a remote one, a CI bridge) — but
they're no longer required for the common case.

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
request. The token is regenerated on every fresh bridge (cold) start —
a surface that *joins* an already-running bridge reuses the live token,
but once that bridge dies the next start mints a new one. So always read
it freshly from the token file (or accept it from the user); never
hardcode it into prompts or committed code, and re-read it after a 401.

The project token authorizes the route, **not the caller's identity**. The
bridge accepts caller-supplied `from`, message type, registration ids, and
acknowledgement `readerId`; it does not separately authorize control/steer
messages. Use an honest, stable agent id, never impersonate `hq@...` or another
agent, and treat every token holder as fully trusted for that project mailbox.

If you're working with explicit env vars:

```ts
const URL = process.env.WRONGSTACK_MAILBOX_URL;
const TOKEN = process.env.WRONGSTACK_MAILBOX_TOKEN;

if (!URL || !TOKEN) {
  throw new Error(
    'WRONGSTACK_MAILBOX_URL and WRONGSTACK_MAILBOX_TOKEN must be set ' +
    'before talking to the WrongStack mailbox bridge. (Or use ' +
    '`mbWithBootstrap()` to discover an already-running bridge from ' +
    'the per-project lock file — see "Discovering the bridge" below.)',
  );
}
```

If you don't have env vars, skip this guard and use `mbWithBootstrap()`
from the next section instead — it discovers the bridge from
`.mailbox-bridge.lock` (and spawns one if none is running).

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

## Discovering the bridge: `mbWithBootstrap()`

The plain `mb()` helper above assumes `WRONGSTACK_MAILBOX_URL` and
`WRONGSTACK_MAILBOX_TOKEN` are set. After the auto-bootstrap wiring,
external agents usually don't have those env vars — they need to
discover the bridge from the per-project lock file (or spawn one).

`mbWithBootstrap()` handles all three scenarios from the
"What this skill assumes" section:

1. **Env vars set** → use them directly.
2. **No env vars, but a WrongStack surface is running** → read the
   `.mailbox-bridge.lock` and `.mailbox.token` files from the project
   directory to discover the running bridge.
3. **No env vars, no surface running, but `wstack` is on PATH** →
   spawn `wstack mailbox serve` as a child process and wait for the
   lock to appear (the bootstrap helper writes it within ~200 ms of
   `listen()` returning). Use this when you want full self-service.

The helper takes a `projectDir` (the absolute path to the user's
WrongStack project root) and returns a configured `mb(path, body)`
function. Call it once at agent startup; use the returned `mb` for
every subsequent route call.

```ts
/**
 * Returns a configured `mb(path, body)` function for talking to
 * the WrongStack mailbox bridge, spawning one if necessary.
 *
 * Discovery order:
 *   1. WRONGSTACK_MAILBOX_URL + WRONGSTACK_MAILBOX_TOKEN env vars
 *      (highest precedence — used as-is).
 *   2. <projectDir>/.mailbox-bridge.lock  (the per-project lock file
 *      written by every running WrongStack surface — read its
 *      `url` + `token` fields).
 *   3. <projectDir>/.mailbox.token         (the token file, in case
 *      the URL is set in env but the token isn't, or vice versa).
 *   4. Spawn `wstack mailbox serve` via async `spawn` + unref, then
 *      poll the lock file for up to 5 s. Used as a last resort when no
 *      WrongStack surface is running yet.
 *
 * Throws only when ALL three fail (no env vars, no lock file, no
 * `wstack` on PATH). The caller decides whether to surface that
 * to the user or fall back to manual setup.
 */
async function mbWithBootstrap(
  projectDir: string,
): Promise<(path: string, body?: unknown) => Promise<unknown>> {
  // 1. Env vars win outright.
  if (process.env.WRONGSTACK_MAILBOX_URL && process.env.WRONGSTACK_MAILBOX_TOKEN) {
    return mb;
  }

  // 2-3. Lock + token files.
  const lockPath = path.join(projectDir, '.mailbox-bridge.lock');
  const tokenPath = path.join(projectDir, '.mailbox.token');
  let url = process.env.WRONGSTACK_MAILBOX_URL;
  let token = process.env.WRONGSTACK_MAILBOX_TOKEN;

  try {
    const lockRaw = await fs.readFile(lockPath, 'utf8');
    const lock = JSON.parse(lockRaw) as { url: string; token: string };
    if (lock.url && lock.token) {
      url = url ?? lock.url;
      token = token ?? lock.token;
    }
  } catch {
    // lock file absent — fall through to spawn step
  }
  if (token === undefined) {
    try {
      token = (await fs.readFile(tokenPath, 'utf8')).trim();
    } catch {
      // token file absent — fall through to spawn step
    }
  }

  // 4. Last resort — spawn `wstack mailbox serve` ourselves.
  //    Use async `spawn` + unref, NOT `spawnSync`: the bridge is a
  //    long-lived server that never exits, so `spawnSync` would block
  //    this agent forever. On Windows `wstack` is a `.cmd` shim, so
  //    `shell:true` is required to resolve it on PATH; `detached` is
  //    POSIX-only (on win32 it pops a visible console window).
  if (url === undefined || token === undefined) {
    try {
      const { spawn } = await import('node:child_process');
      const isWin = process.platform === 'win32';
      const child = spawn('wstack', ['mailbox', 'serve'], {
        cwd: projectDir,
        detached: !isWin,
        stdio: 'ignore',
        windowsHide: true,
        shell: isWin,
      });
      // Spawn errors (e.g. wstack not on PATH) surface via the
      // poll-timeout below rather than crashing the agent.
      child.on('error', () => undefined);
      child.unref();
      // Poll for the lock file for up to 5 s.
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
        try {
          const raw = await fs.readFile(lockPath, 'utf8');
          const lock = JSON.parse(raw) as { url: string; token: string };
          if (lock.url && lock.token) {
            url = lock.url;
            token = lock.token;
            break;
          }
        } catch {
          // not yet — keep polling
        }
      }
    } catch (err) {
      throw new Error(
        `Could not find or start a WrongStack mailbox bridge for ` +
        `${projectDir}. Tried env vars, the per-project lock + token ` +
        `files, and spawning \`wstack mailbox serve\`. Last error: ` +
        (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // Set env vars for the inner `mb` helper so it picks them up
  // without further branching. (Strictly optional — could also
  // close over `url` and `token` directly.)
  process.env.WRONGSTACK_MAILBOX_URL = url;
  process.env.WRONGSTACK_MAILBOX_TOKEN = token;
  return mb;
}
```

Usage:

```ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const mb = await mbWithBootstrap('/path/to/wrongstack/project');
const { data } = await mb('/mailbox/query', {
  to: agentId,
  incompleteOnly: true,
  limit: 50,
}) as { data: MailboxMessage[] };
```

### When to prefer `mb()` over `mbWithBootstrap()`

If you've already been given a URL + token (env vars, CLI args, a
config file), use plain `mb()`. The bootstrap path is for
discovery-first integrations — agents that want to "just connect to
whatever's running" without asking the user.

## Patterns

### Discover a running bridge without env vars

The recommended pattern for an agent that doesn't have
`WRONGSTACK_MAILBOX_URL` / `WRONGSTACK_MAILBOX_TOKEN` pre-set:

```ts
import * as path from 'node:path';

async function findBridge(projectDir: string): Promise<{ url: string; token: string } | null> {
  const lockPath = path.join(projectDir, '.mailbox-bridge.lock');
  try {
    const raw = await fs.readFile(lockPath, 'utf8');
    const lock = JSON.parse(raw) as { url: string; token: string; pid: number };
    if (!lock.url || !lock.token) return null;
    // Optional: ping /healthz to confirm the PID is actually serving
    // (a crashed-but-not-cleaned-up lock would still parse).
    const res = await fetch(`${lock.url}/healthz`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok ? { url: lock.url, token: lock.token } : null;
  } catch {
    return null;
  }
}
```

For the "no env vars AND no running surface" case, fall back to
`mbWithBootstrap()` above (which spawns `wstack mailbox serve` for
you and waits for the lock file to appear).

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

### Real-time push via SSE (preferred) or polling

The bridge supports **Server-Sent Events (SSE)** on `GET /mailbox/events`
for real-time push. This is the preferred approach — no polling needed.

```ts
// Open an SSE connection that pushes events in real-time.
const res = await fetch(`${url}/mailbox/events`, {
  headers: { Authorization: `Bearer ${token}` },
});
const reader = res.body!.getReader();
const decoder = new TextDecoder();

for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  const text = decoder.decode(value);
  // SSE events arrive as: data: {"type":"message.sent",...}\n\n
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const event = JSON.parse(line.slice(6));
    if (event.type === 'message.sent') {
      console.log(`[${event.type}] ${event.from} → ${event.to}: ${event.messageId}`);
      // Fetch the full message via /mailbox/query or /mailbox/check.
    }
  }
}
```

**SSE event types:**

| Event `type` | When | Payload fields |
|--------------|------|---------------|
| `message.sent` | A message was sent via `POST /mailbox/send` | `messageId`, `from`, `to`, `timestamp` |

The SSE stream sends a `: connected` comment on open and a
`: keepalive` comment every 15 s to prevent proxy/CDN timeouts.

**Important:** SSE events carry only the message id and metadata — not
the full message body. When you receive an event, call `/mailbox/check`
or `/mailbox/query` to fetch the complete message content.

**Fallback: polling.** If your HTTP client doesn't support SSE (or you're
behind a proxy that buffers responses), poll on a 5–10 s interval. Don't
poll faster than 1 Hz — the bridge enforces a rate limit of 120 requests
per minute per bearer token.

```ts
// Fallback: poll every 5 s when SSE is unavailable.
async function pollOnce(): Promise<void> {
  const result = await mb('/mailbox/check', {
    agentId,
    baseId: 'claude-code',       // optional: your bare alias
    limit: 50,
  }) as { data: MailboxMessage[] };

  for (const m of result.data) {
    console.log(`[${m.type}] from=${m.from} subject=${m.subject}`);
    // ...handle the message...
  }
}

setInterval(pollOnce, 5_000);
```

Use `/mailbox/query` directly when you need custom searches such as
`from`, `type`, `since`, or `minPriority` filters rather than inbox
catch-up.

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

### Complete messages while checking inbox

If handling a message finishes the requested work, mark it completed in the
same `/mailbox/check` call. This preserves read receipts and completion
state with one batch ack:

```ts
const result = await mb('/mailbox/check', {
  agentId,
  baseId: 'claude-code',
  completed: true,
  outcome: 'handled',
}) as { data: MailboxMessage[] };
```

Use `markRead: false` to peek without consuming messages:

```ts
await mb('/mailbox/check', { agentId, markRead: false });
```

### Ack in batches

If you've just consumed a backlog through custom `/mailbox/query` filters,
don't ack them one at a time. Use `/mailbox/ack-many` — one HTTP request,
one file-lock acquisition, one JSONL rewrite inside WrongStack:

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
| POST | `/mailbox/send` | Send a message (optional `ttlMs`; optional `audience: "leaders"` prevents subagent consumption) |
| POST | `/mailbox/query` | Query messages (filters: `to`, `from`, `unreadBy`, `type`, `minPriority`, `incompleteOnly`, `limit`, `since`) |
| POST | `/mailbox/check` | Read inbox mail for `agentId`/`baseId` plus broadcasts; optionally `markRead=false`, `completed=true`, `outcome` |
| POST | `/mailbox/ack` | Acknowledge one message |
| POST | `/mailbox/ack-many` | Acknowledge many in one batch |
| POST | `/mailbox/unread-count` | Count unread for an agent |
| POST | `/mailbox/agents/register` | Register this external agent |
| POST | `/mailbox/agents/heartbeat` | Update agent heartbeat |
| POST | `/mailbox/register-client` | Register this external client (different from agent — for session-level liveness) |
| POST | `/mailbox/heartbeat` | Update client heartbeat |
| GET | `/mailbox/agents` | List all registered agents |
| GET | `/mailbox/agents/online` | List agents with a live heartbeat (within 60 s) |
| GET | `/mailbox/events` | **SSE stream** — real-time push of mailbox events (auth required) |
| GET | `/healthz` | Liveness probe — does NOT require auth |

### Error shape

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "field \"from\" is required (string)" } }
```

| Code | HTTP | What it means / what to do |
|------|------|----------------------------|
| `VALIDATION_ERROR` | 400 | Missing or wrong-type field. Read the message; it tells you which field. |
| `UNAUTHORIZED` | 401 | Token mismatch. Re-read `~/.wrongstack/projects/<slug>/.mailbox.token` and try again — the bridge may have restarted. |
| `RATE_LIMITED` | 429 | Rate limit exceeded (max 120 requests/min per token). Slow down or use SSE instead of polling. |
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
- **Don't poll faster than 1 Hz.** The bridge enforces a rate limit of
  120 requests/min per bearer token (returns `429 RATE_LIMITED` beyond
  that). Prefer SSE (`GET /mailbox/events`) over polling when possible.
- **Don't include the token in any logged output.** It's the only
  credential. If you must print the URL, redact the token (`[REDACTED]`).
- **Don't reply to a broadcast with another broadcast.** Replies should
  target the original sender via `to: <their-id>`, with `replyTo` set.
- **Avoid `control` messages.** They go through a different path in
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

After installation, the external agent can talk to any WrongStack
project whose bridge is already running (most common case — the user
opens `wstack --repl` or `wstack --webui` and the bridge
auto-bootstraps). `mbWithBootstrap()` handles discovery without
requiring the user to copy URL/token env vars around.

If no WrongStack surface is running yet, the user starts one —
`wstack --repl`, `wstack --webui`, `wstack --eternal`, or `wstack
mailbox serve` standalone all work. The first one to come up for a
given project starts the bridge; subsequent surfaces join it via the
per-project lock.

## Out of scope

- **Don't open Mailbox files directly.** No `_mailbox.sqlite`, no legacy JSONL, no bridge locks, no token files. The bridge and `mb()` / `mbWithBootstrap()` are the only paths; bypassing them breaks trust and audit.
- **Don't impersonate `hq@...` or another agent.** Use a stable, honest `agentId` for your own identity. The bridge does not enforce sender identity; impersonation is on you, and it's the kind of thing that gets the bridge shut down.
- **Don't hardcode the token.** Read it from `.mailbox.token`, `.mailbox-bridge.lock`, or accept it from the user. Re-read after a 401. Tokens rotate on every fresh bridge start.
- **Don't let requests hang.** `AbortSignal.timeout(10_000)` is mandatory. The mailbox is local; 10 s is generous, and a hung bridge will wedge the agent.
- **Don't poll faster than 1 Hz.** The bridge enforces 120 req/min/token. Polling at sub-second rates hits the limit and looks like a flooding attempt.
- **Don't use SSE events as authoritative.** `GET /mailbox/events` is a wake-up hint, not a snapshot. After every event, reconcile through `/mailbox/query` or `/mailbox/check`.
- **Don't broadcast without thinking.** `to: "*"` reaches every online agent. One broadcast per task, with a clear subject. The WebUI marks broadcasts with a different color and humans notice noise.
- **Don't ack in a loop when `ack-many` fits.** If you have more than one unread message, use `/mailbox/ack-many` — one request, one lock, one rewrite.
- **Don't skip `register_self`.** Without registration, the WebUI can't show you as online, and heartbeats are unreconciled.
- **Don't randomize your `agentId`.** Read receipts and history break if your id changes every poll. Pick a stable convention and reuse it.
- **Don't promise features the bridge doesn't expose.** The bridge is mailbox only. For the full WrongStack tool surface, use `wstack mcp serve`; for SMTP/IMAP, push back — WrongStack's mailbox is internal.

## Before returning

- [ ] No Mailbox files opened or edited directly; bridge and `mb()` only
- [ ] Stable, honest `agentId`; no impersonation of `hq@...` or other agents
- [ ] Token read from `.mailbox.token` or `.mailbox-bridge.lock`, not hardcoded
- [ ] `mbWithBootstrap()` used for discovery when env vars aren't set
- [ ] All requests carry `AbortSignal.timeout(10_000)`
- [ ] `register_self` called with stable name and role before any traffic
- [ ] Heartbeat every 30 s; `deregister_self` on clean shutdown
- [ ] SSE preferred for real-time; polling ≥ 1 Hz, ≤ 5–10 s
- [ ] `ack-many` used when more than one message needs acknowledgement
- [ ] Broadcast only with clear subject, at most once per task
- [ ] Bridge health (`/healthz`) probed before relying on routes

## Skills in scope

- `node-modern` — `AbortSignal.timeout`, ESM-only imports.
- `output-standards` — when reporting mailbox activity to the user,
  shape it as the project's standard output.
- `prompt-engineering` — when composing `subject`/`body` text that
  other agents will read, keep it specific and short.
