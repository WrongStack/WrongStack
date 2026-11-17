# @wrongstack/client

Typed client for a running WrongStack WebUI server (`wstack --webui`). It lets you:

- open sessions and resume them
- send prompts and stream the run
- answer tool confirmations
- read every live session on the machine over the HTTP API

It works in Node 22+ and in the browser. At runtime it loads only one small module from `@wrongstack/webui-protocol`, and that module imports nothing. The install is heavier: that package, which the types come from, depends on `@wrongstack/core`.

This package is part of the WrongStack monorepo and is not published to npm:
npm publishing was retired after 1.1.11, and the versions already on npm are
frozen. Inside the workspace, depend on it directly:

```json
"@wrongstack/client": "workspace:*"
```

## Conversation

```ts
import { WrongStackClient } from '@wrongstack/client';

const client = await WrongStackClient.connect({
  url: 'http://127.0.0.1:3456',
  token: process.env.WEBUI_TOKEN, // the token in the URL `wstack --webui` prints
  onConfirm: (request) => (request.toolName === 'read' ? 'yes' : undefined),
});

const run = client.send('Summarise README.md');
for await (const event of run) {
  if (event.type === 'provider.text_delta') process.stdout.write(event.payload.text);
  if (event.type === 'tool.started') console.log(`\n[${event.payload.name}]`);
}
const result = await run.result; // { status, iterations, text, error? }
client.close();
```

- `send(text, { sessionId?, images?, freshContext? })` returns a `Run`. You can use it in three ways:
  - Iterate it for the protocol's own frames (`provider.text_delta`, `tool.started`, `tool.executed`, `tool.confirm_needed`, …).
  - Await `run.result` for how it ended.
  - Await `run.text()` for the answer. It throws when the run did not finish.
- `run.abort()` stops the run. The result then has `status: 'aborted'`.
- Confirmations: `onConfirm` answers them as they arrive. Return nothing to answer later with `run.confirm(id, decision)`.
- Sessions:
  - `listSessions(limit)` lists sessions.
  - `newSession()` and `resumeSession(id)` switch the client's current session, the one prompts go to.
- Other frames: `client.on(type, listener)` is typed for the conversation core and accepts any other type the server sends with an `unknown` payload. `client.post(frame)` sends any frame.
- The server drops a prompt identical to the previous one if it comes within 1.5 s of that run ending, as an accidental double send. That run reports `done` with 0 iterations.

## Reconnecting

If the socket drops, the client reconnects on its own and catches up on what the server sent in the meantime:

- A run in flight keeps its events, gets the frames it missed in order and exactly once, and still settles with its result.
- `client.state` is `open`, `reconnecting` or `closed`. `onStateChange(listener)` reports each change, with the error that caused a drop.
- While reconnecting, `send` and `post` fail with `connection/reconnecting`, which is `retryable`.
- The retry policy is `reconnect: { attempts: 10, initialDelayMs: 500, maxDelayMs: 10_000 }` (the delay doubles after each failure). Pass `reconnect: false` to make a drop final.

Some losses the server cannot make up for. The affected run fails with:

| code | when |
| --- | --- |
| `server_restarted` | the server restarted while the run was in flight |
| `result_lost` | the run ended while the connection was down, and the server's log no longer holds its result |

## Errors

Every failure is a `WrongStackError` with a stable `kind`, a narrowing `code`, a human `detail` and `retryable`.

| kind | when |
| --- | --- |
| `auth` | the access token was refused (`code: '401'`) |
| `connection` | the server is unreachable, the socket closed for good, or it is reconnecting |
| `timeout` | no answer within `timeoutMs` (default 15 s) |
| `server` | the server refused the turn (`session_not_ready`, a busy session, a failed `agent.run`) |
| `run` / `aborted` | on `result.error` when the run did not finish |
| `invalid` / `not_found` | HTTP 400 / 404 |
| `protocol` | a response that is not what the contract says |

## HTTP session API

```ts
import { createHttpClient } from '@wrongstack/client';

const api = createHttpClient({ url: 'http://127.0.0.1:3456', token });
const sessions = await api.listLiveSessions(); // every live session on the machine
await api.messageSession(sessions[0].sessionId, { text: 'wrap up', type: 'steer' });
```

HTTP session API requests refuse redirects so the access token and message bodies
stay on the configured server. Use the server's direct URL, not a redirecting endpoint.

## The contract

The frame and body types are the ones in `@wrongstack/webui-protocol`, and the server and the WebUI build against them too. For clients in other languages, that package publishes files generated from those types:

- `@wrongstack/webui-protocol/schema/ws-core.schema.json`: JSON Schema of the conversation core.
- `@wrongstack/webui-protocol/schema/openapi.json`: OpenAPI 3.1 of the HTTP session API.
