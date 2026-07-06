# @wrongstack/acp — ACP v1 SDK

Agent Client Protocol (ACP) v1 implementation for WrongStack, wrapping the official
[`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk).

**100% spec coverage.** Both client and server sides fully implemented.

## Compliance

[![ACP v1 Compliant](https://img.shields.io/badge/ACP%20v1-100%25%20compliant-2ea44f)](COMPLIANCE.md)

**143 compliance checks — 0 failures.** See [COMPLIANCE.md](COMPLIANCE.md) for the full audit report.

## Installation

```bash
pnpm add @wrongstack/acp
```

## Quick Start

### ACP Client (connect to an external agent)

```typescript
import { ACPSession, textContent } from '@wrongstack/acp';

// Spawn and initialize an ACP agent
const session = await ACPSession.start({
  command: 'claude',
  projectRoot: process.cwd(),
});

// Run a prompt turn
const result = await session.prompt(
  [textContent('Generate a unit test for this function.')],
  new AbortController().signal,
);

console.log(result.text); // Agent's response
await session.close();
```

### ACP Server (expose WrongStack as an ACP agent)

```typescript
import { WrongStackACPServer, makeACPServerAgentTurn } from '@wrongstack/acp';

const agentFor = async (sessionId: string) => {
  // Create a WrongStack Agent instance for this session
  return createAgent({ provider: 'anthropic', model: 'claude-3-opus' });
};

const server = new WrongStackACPServer({
  runTurn: makeACPServerAgentTurn({ agentFor }),
  transport: 7788, // HTTP mode on port 7788
});

await server.start();
```

### Using the Official SDK (for advanced use cases)

```typescript
import { ACPSession, AcpServer, createWebSocketStream } from '@wrongstack/acp/sdk';
```

The `/sdk` entry point re-exports everything from `@agentclientprotocol/sdk` alongside
WrongStack's own implementation.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       @wrongstack/acp                            │
│                                                                 │
│   ┌─────────────────┐    ┌─────────────────┐                    │
│   │  Client SDK     │    │  Server SDK     │                    │
│   │  (acp-session)  │    │  (protocol-handler)                   │
│   │                 │    │                  │                    │
│   │  › ACPSession   │    │  › ACPProtocolHandler                │
│   │  › ACPSession-  │    │  › WrongStackACPServer               │
│   │    Error         │    │  › ACPServerAgentTurn                │
│   │  › FileServer   │    │  › ACPSessionStore                   │
│   │  › Terminal-    │    │  › RunTurn                           │
│   │    Server       │    │                                      │
│   └────────┬────────┘    └──────────┬──────────────────────────┘ │
│            │                        │                            │
│   ┌────────┴────────────────────────┴────┐                       │
│   │         Transports                    │                       │
│   │  stdio │ HTTP │ WebSocket │ SSE      │                       │
│   └───────────────────────────────────────┘                       │
│                                                                   │
│   ┌────────────────────────────────────────────┐                  │
│   │  Official SDK Bridge (@agentclientprotocol/ │                  │
│   │  sdk)                                      │                  │
│   │                                            │                  │
│   │  › AcpServer, AgentApp, ClientApp          │                  │
│   │  › ActiveSession, SessionBuilder           │                  │
│   │  › createWebSocketStream                   │                  │
│   │  › Schema types (200+ ACP types)           │                  │
│   └────────────────────────────────────────────┘                  │
└──────────────────────────────────────────────────────────────────┘
```

## Client SDK

### ACPSession

An `ACPSession` connects to an external ACP-supporting agent (Claude Code,
Gemini CLI, Codex CLI, etc.) as a subprocess or over a network transport.

#### Connection

```typescript
const session = await ACPSession.start({
  command: 'claude',
  args: ['--model', 'anthropic-test-model'],
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
  cwd: '/path/to/project',
  projectRoot: '/path/to/project',
  mcpServers: [
    { name: 'filesystem', command: '/usr/bin/mcp-filesystem' },
  ],
});
```

#### Authentication

```typescript
if (session.requiresAuth()) {
  const methods = session.getAuthMethods();
  // methods: [{ id: 'agent-login', name: 'Agent login', ... }]
  await session.authenticate('agent-login');
}
```

#### Sessions

```typescript
// Prompt (creates session automatically if needed)
const result = await session.prompt(
  [textContent('Hello!'), imageContent('image/png', base64Data)],
  signal,
);

// Load existing session
await session.loadSession('sess_abc123');

// Resume without replay
await session.resumeSession('sess_abc123');

// List sessions
const { sessions } = await session.listSessions();

// Delete a session
await session.deleteSession('sess_abc123');

// Graceful close
await session.close();
```

#### Accessors

```typescript
session.getCapabilities();       // AgentCapabilities
session.getAuthMethods();        // AuthMethod[]
session.getAgentInfo();          // { name, title?, version }
session.requiresAuth();          // boolean
session.getSessionId();          // SessionId | null
```

### Content Helpers

```typescript
import { textContent, imageContent, audioContent } from '@wrongstack/acp';

// Text
textContent('Hello world');

// Image (only if agent's promptCapabilities.image === true)
imageContent('image/png', base64String);

// Audio (only if agent's promptCapabilities.audio === true)
audioContent('audio/wav', base64String);

// Check agent capabilities first
const caps = session.getCapabilities();
if (caps.promptCapabilities?.image) {
  blocks.push(imageContent('image/png', screenshot));
}
```

### File & Terminal Servers

Clients implement `fs/*` and `terminal/*` methods that the agent calls:

```typescript
import { FileServer, TerminalServer } from '@wrongstack/acp/client';

const fileServer = new FileServer({ projectRoot: '/path' });
const { content } = await fileServer.readTextFile({ path: '/path/file.ts' });

const terminalServer = new TerminalServer({ projectRoot: '/path' });
const { terminalId } = terminalServer.create({
  command: 'node',
  args: ['-e', 'console.log("hi")'],
});
```

## Server SDK

### WrongStackACPServer

Exposes WrongStack as an ACP-compatible agent:

```typescript
import {
  WrongStackACPServer,
  makeACPServerAgentTurn,
} from '@wrongstack/acp';

const server = new WrongStackACPServer({
  runTurn: makeACPServerAgentTurn({
    agentFor: async (sessionId, cwd) => {
      return myAgentFactory(sessionId, cwd);
    },
  }),
  agentName: 'my-agent',
  defaultCwd: process.cwd(),
  transport: 7788,            // HTTP mode (omit for stdio)
  host: '127.0.0.1',
});

await server.start();
```

### HTTP Transport

When `transport` is a number, the server listens as HTTP:

```bash
# Client connects via:
curl -X POST http://127.0.0.1:7788 \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}'
```

### Session Persistence

```typescript
import { ACPSessionStore } from '@wrongstack/acp';

const store = new ACPSessionStore({ dir: './.acp-sessions' });
await store.init();
await store.save(sessionState);
const loaded = await store.load('sess_abc');
const all = await store.list();
await store.delete('sess_abc');
```

### Plan & Usage Updates

The server emits `plan` and `usage_update` notifications when the Agent
provides them:

```typescript
// In your agent factory:
const result = await agent.run(prompt, { signal });

// If result.plan is an array, session/update plan notifications fire
// If result.usage is provided, session/update usage_update fires
```

## Supported Methods

### Client → Agent (ACPSession methods)

| Method | ACPSession API | Status |
|--------|---------------|--------|
| `initialize` | `ACPSession.start()` | ✅ |
| `authenticate` | `session.authenticate(methodId)` | ✅ |
| `logout` | `session.logout()` | ✅ |
| `session/new` | Auto-created on first `prompt()` | ✅ |
| `session/load` | `session.loadSession(id)` | ✅ |
| `session/resume` | `session.resumeSession(id)` | ✅ |
| `session/close` | `session.close()` | ✅ |
| `session/delete` | `session.deleteSession(id)` | ✅ |
| `session/list` | `session.listSessions()` | ✅ |
| `session/fork` | `session.forkSession(id)` | ✅ |
| `session/prompt` | `session.prompt(blocks, signal)` | ✅ |
| `session/cancel` | Via `AbortSignal` | ✅ |
| `session/set_mode` | `session.setMode(sessionId, modeId)` | ✅ |
| `session/set_config_option` | `session.setConfigOption(sessionId, optionId, value)` | ✅ |
| `providers/list` | `session.listProviders()` | ✅ |
| `providers/set` | `session.setProvider(providerId, config?)` | ✅ |
| `providers/disable` | `session.disableProvider()` | ✅ |
| `mcp/message` | `session.mcpMessage(connectionId, message)` | ✅ |

### Agent → Client (handled by ACPSession)

| Method | Handler | Status |
|--------|---------|--------|
| `session/update` | Stream pump (11 discriminators) | ✅ |
| `session/request_permission` | Permission policy callback | ✅ |
| `fs/read_text_file` | FileServer (sandboxed) | ✅ |
| `fs/write_text_file` | FileServer (sandboxed) | ✅ |
| `terminal/create` | TerminalServer | ✅ |
| `terminal/output` | TerminalServer | ✅ |
| `terminal/wait_for_exit` | TerminalServer | ✅ |
| `terminal/kill` | TerminalServer | ✅ |
| `terminal/release` | TerminalServer | ✅ |

### Server (Agent) — handled by ACPProtocolHandler

| Method | Handler | Status |
|--------|---------|--------|
| `initialize` | `handleInitialize` | ✅ |
| `authenticate` | `handleAuthenticate` | ✅ |
| `logout` | `handleLogout` | ✅ |
| `session/new` | `handleSessionNew` | ✅ |
| `session/load` | `handleSessionLoad` | ✅ |
| `session/resume` | `handleSessionResume` | ✅ |
| `session/close` | `handleSessionClose` | ✅ |
| `session/delete` | `handleSessionDelete` | ✅ |
| `session/fork` | `handleSessionFork` | ✅ |
| `session/list` | `handleSessionList` | ✅ |
| `session/prompt` | `handleSessionPrompt` | ✅ |
| `session/cancel` | Notification handler | ✅ |
| `session/set_mode` | `handleSetMode` | ✅ |
| `session/set_config_option` | `handleSetConfigOption` | ✅ |
| `providers/list` | `handleProvidersList` | ✅ |
| `providers/set` | `handleProvidersSet` | ✅ |
| `providers/disable` | `handleProvidersDisable` | ✅ |
| `mcp/message` | `handleMcpMessage` | ✅ |
| `document/*` | Auto-acknowledged | ✅ |
| `nes/*` | Auto-acknowledged | ✅ |
| `elicitation/*` | Auto-acknowledged | ✅ |
| `$/cancel_request` | Notification handler | ✅ |

## Transport

| Transport | Client | Server | Library |
|-----------|--------|--------|---------|
| stdio | ✅ `ACPSession.start()` | ✅ `WrongStackACPServer` | Built-in |
| HTTP | ✅ Via `ACPSession` + fetch | ✅ `transport: <port>` | Built-in |
| WebSocket | ✅ `createWebSocketStream()` | ✅ `AcpServer` + `createNodeWebSocketUpgradeHandler()` | Official SDK |
| SSE | ✅ Via `AcpServer` | ✅ Via `AcpServer` | Official SDK |

## Error Handling

```typescript
import { ACPSession, ACPSessionError } from '@wrongstack/acp';

try {
  const result = await session.prompt(blocks, signal);
} catch (err) {
  if (err instanceof ACPSessionError) {
    switch (err.kind) {
      case 'spawn_failed':      // Child process couldn't start
      case 'init_failed':       // Initialize handshake failed
      case 'auth_failed':       // Authentication rejected
      case 'prompt_failed':     // Prompt turn returned error
      case 'aborted':           // User aborted via signal
      case 'closed':            // Session was closed
      case 'unsupported_capability':  // Agent can't do what we need
      case 'protocol_error':    // Unexpected wire message
    }
  }
}
```

## Related

- [ACP Specification](https://agentclientprotocol.com)
- [Official TypeScript SDK](https://github.com/agentclientprotocol/typescript-sdk)
- [WrongStack CLI (`wstack acp`)](../../packages/cli/src/slash-commands/acp.md)
