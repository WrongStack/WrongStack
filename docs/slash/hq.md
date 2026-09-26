# /hq — Connect to a WrongStack HQ command center

## What It Does

Points this TUI/REPL client at a WrongStack **HQ** command center so it streams
its live session + agents (and full chat transcript) there, and lets you inspect
the connection. HQ is the read-only dashboard started with `wstack --hq`; see
[`--hq`](../subcommands/hq.md) for the server side.

A local `wstack --hq` is **auto-discovered** (via `~/.wrongstack/hq/runtime.json`)
with no configuration — even when the HQ starts *after* this client or restarts
on a different port. While no HQ is running the client stays dormant (no socket,
cheap file poll) and queues telemetry in a bounded buffer that flushes on attach;
bare `/hq` reports `mode: auto-discovery` in that state. Use `/hq set` to point
at an HQ on **another machine**; disable entirely with `/hq off`.

## Usage

| Usage | Effect |
|---|---|
| `/hq` | Show connection status (resolved URL, token, source, reachability) |
| `/hq status` | Same as bare `/hq` |
| `/hq set <url> [token]` | Configure HQ URL + optional client token, e.g. `/hq set http://192.168.1.20:3499 my-client-token` |
| `/hq token <token>` | Set just the client token |
| `/hq raw on` / `/hq raw off` | Publish raw chat/tool content to HQ. Default: **on** for every HQ target unless explicitly disabled. Use `raw off` only when you explicitly want redacted telemetry |
| `/hq on` | Enable HQ publishing |
| `/hq off` | Disable HQ publishing |
| `/hq clear` | Remove all HQ settings |

## Notes

- Settings persist to the active profile config (user scope) under `hq`.
- `/hq set`, `token`, `on`, `off`, `clear` and `raw on|off` apply **live**: the
  running terminal session re-points (or disconnects) within a few seconds. A
  change of endpoint or raw policy rebuilds the publisher, so HQ sees a new
  client id for this terminal. (Auto-discovery also attaches live when a local
  HQ appears or repoints, keeping the same client id.)
- Redaction is
  applied publisher-side (before events leave the client process), and the HQ
  operator can still force redaction server-side via the `redactionPolicy`
  override in `~/.wrongstack/hq/auth.json` — that clamp is one-way (it can
  tighten, never loosen).
- The client token is for the `/ws/client` channel and is distinct from the HQ
  **browser** token (used to open the dashboard in a browser).
- `set` / `status` run a quick reachability probe against the HQ URL. A `401`
  still counts as *reachable* (the server is up, just token-gated).

## Resolution order

1. `WRONGSTACK_HQ_URL` / `WRONGSTACK_HQ_TOKEN` env vars (override the config file)
2. `config.json` → `hq.url` / `hq.token`
3. **Auto-discovery** (no explicit URL anywhere): the publisher re-reads
   `~/.wrongstack/hq/runtime.json` + the first client token from `auth.json`
   before every connect attempt, and polls while dormant — a later-started or
   restarted HQ is attached to automatically. Opt out with
   `WRONGSTACK_HQ_ENABLED=0`, `hq.enabled: false`, or `/hq off`.

## Code Reference

- `packages/cli/src/slash-commands/hq.ts`
- `packages/core/src/hq/factory.ts` (`resolveHqConfig`)
- `packages/core/src/hq/session-bridge.ts` (telemetry stream)
- `packages/cli/src/hq-server.ts` (the `--hq` server)
