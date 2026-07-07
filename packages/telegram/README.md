# @wrongstack/telegram

Telegram bridge for WrongStack — connect your agent to Telegram.
Send messages, receive instructions, get notified when long tasks finish.

## Features

- **`telegram_read`** — Agent reads incoming Telegram messages (newest first, filtered by chat, with ack support)
- **`telegram_send`** — Agent sends messages via Telegram (HTML formatting, confirm permission)
- **System prompt injection** — Unread messages appear in the agent's system prompt so it sees them naturally
- **Slash commands** — `/telegram`, `/telegram-health`, `/telegram:send`, `/telegram:chatid` in the TUI
- **Event notifications** — Session end summaries and long tool completions forwarded to Telegram
- **Allowlist filtering** — Restrict which users/chats can interact with the bot
- **Zero dependencies** — Uses Node.js native `fetch`, no third-party Telegram libraries

## Quickstart

### 1. Create a bot

Message [@BotFather](https://t.me/BotFather) on Telegram:
```
/newbot
```

Copy the token (looks like `123456789:ABCdef...`).

### 2. Get your chat ID

Message your new bot, then visit:
```
https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
```

Find your `chat.id` in the response.

### 3. Enable the official plugin

```bash
wstack plugin install telegram
```

`telegram` is the bundled official alias for `@wrongstack/telegram`. In
WrongStack 0.3.4 and newer, the package is installed with the `wrongstack`
umbrella package; this command only enables plugin loading in config and does
not run npm.

If you are installing the plugin into a custom host instead of the official
CLI package, add it like a normal public package:

```bash
npm install @wrongstack/telegram
```

### 4. Configure

In `~/.wrongstack/config.json` or `.wrongstack/config.json`:

```jsonc
{
  "features": {
    "plugins": true
  },
  "plugins": ["@wrongstack/telegram"],
  "extensions": {
    "telegram": {
      "botToken": "123456789:ABCdefGHIjkl...",
      "notifyChatId": "987654321",
      "allowedUsers": [987654321],
      "notifyOnSessionEnd": true,
      "longToolThresholdMs": 30000,
      "pollIntervalSec": 2
    }
  }
}
```

The `plugins` array controls loading. `extensions.telegram` stores this
plugin's options.

The plugin loads on the next WrongStack start. Use
`wstack plugin disable @wrongstack/telegram` and
`wstack plugin enable @wrongstack/telegram` to turn it off/on without deleting
the Telegram options.

## Configuration reference

| Field | Type | Required | Default | Description |
|---|---|---|---|---|
| `botToken` | `string` | **yes** | — | Bot token from @BotFather |
| `notifyChatId` | `string \| number` | no | — | Default chat for outgoing messages and notifications |
| `allowedUsers` | `(string \| number)[]` | no | `[]` | User IDs allowed to interact. Empty = all allowed |
| `allowedChats` | `(string \| number)[]` | no | `[]` | Chat IDs the bot reads from. Empty = all allowed |
| `pollIntervalSec` | `number` | no | `2` | How often to poll Telegram for new messages (1–60) |
| `notifyOnSessionEnd` | `boolean` | no | `false` | Send token usage summary when a session ends |
| `longToolThresholdMs` | `number` | no | `30000` | Notify when a tool runs longer than this (ms). `0` = off |
| `maxMessageLength` | `number` | no | `4000` | Max chars per outgoing message (Telegram limit: 4096) |
| `singleInstanceLock` | `boolean` | no | `true` | Elect a single poller per bot token across wstack instances. Extra instances stand by and take over when the active one stops (prevents HTTP 409 conflicts) |

## Tools

### `telegram_read`

Read buffered incoming messages.

```jsonc
// Read all recent messages
telegram_read()

// Read from a specific chat
telegram_read(chat_id: "987654321", limit: 5)

// Read and acknowledge (clear from buffer)
telegram_read(ack_last: 42)
```

Permission: `auto` | Category: `Telegram`

### `telegram_send`

Send a message to a Telegram chat.

```jsonc
// Send using default chat
telegram_send(message: "Build succeeded ✓")

// Send to a specific chat
telegram_send(chat_id: "123456", message: "Deploy complete. Check staging.")
```

Permission: `confirm` | Category: `Telegram`

Message text supports Telegram HTML: `<b>bold</b>`, `<i>italic</i>`, `<code>mono</code>`, `<a href="...">links</a>`, `<pre>code blocks</pre>`.

## Slash commands (TUI)

| Command | Description |
|---|---|
| `/telegram` | Plugin-name alias for Telegram bot health. |
| `/telegram-health` | Explicit Telegram bot health command: connection, polling config, allowlist stats, notification settings. |
| `/telegram:send [chat_id] <msg>` | Send a message from the terminal |
| `/telegram:chatid` | Show the configured default chat ID |

## How it works

```
┌─────────────────┐     poll      ┌──────────────┐
│  Telegram API   │◄──────────────│  TelegramBot  │
│  (getUpdates)   │──────────────►│  (buffer)     │
└────────┬────────┘   updates     └──────┬───────┘
         │                               │
    user sends                      ┌────▼───────┐
    "build failed?"                 │  PluginAPI  │
                                    │  .emitCustom│
                                    │  .contrib.  │
                                    └────┬───────┘
                                         │
                               ┌─────────▼─────────┐
                               │  Agent sees inbox │
                               │  in system prompt │
                               │  calls read/send  │
                               └───────────────────┘
```

1. Bot polls Telegram every N seconds via `getUpdates`
2. Incoming messages go into a circular buffer (50 max)
3. A system prompt contributor injects unread messages so the agent sees them
4. Agent reads with `telegram_read`, responds with `telegram_send`
5. Custom event `telegram:message_received` fires for TUI panels / other plugins

## Events

| Event | Payload | When |
|---|---|---|
| `telegram:message_received` | `TelegramIncomingMessage` | Incoming message passes allowlist |
| `session.ended` | session summary → Telegram | If `notifyOnSessionEnd: true` |
| `tool.executed` | tool result → Telegram | If duration > `longToolThresholdMs` |

## License

MIT
