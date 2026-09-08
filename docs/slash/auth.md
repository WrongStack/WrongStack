# /auth — Interactive Key Manager (TUI) & Key Status Dashboard

In the TUI, `/auth` opens the **interactive auth panel** — the full
`wstack auth` experience embedded in the session: browse saved providers,
add/update/delete/activate keys, add providers from the models.dev catalog,
configure local LLM servers (OmniRoute / Ollama / vLLM / LM Studio, with a
health probe), and sign in with registered provider OAuth strategies.

In the plain REPL (no TUI), `/auth` falls back to a read-only dashboard and
points at `wstack auth`.

## Usage

| Usage | Effect (TUI) | Effect (REPL) |
|---|---|---|
| `/auth` | Open the interactive auth panel | List providers with key counts |
| `/auth login` | Open the OAuth sign-in view | Show `wstack auth login …` hints |
| `/auth status <provider>` | Show detail for one provider (text) | Same |
| `/auth open` | Open the interactive auth panel | Show how to launch `wstack auth` |
| `/auth help` | Show usage help | Same |

`oauth` and `signin` are aliases for `login`; `menu` is an alias for `open`.

## The auth panel (TUI)

```
╭──────────────────────────────────────────────────────────╮
│ API keys & sign-in                                       │
│ ↑/↓ select · Enter open · Esc close                      │
│                                                          │
│ › anthropic              anthropic          2 keys       │
│   openai-codex           openai-codex       1 key sk-a…  │
│   ＋ Add provider (models.dev catalog)                   │
│   ＋ Add local server (OmniRoute / Ollama / vLLM / …)    │
│   ＋ Add custom provider                                 │
│   ⚡ Sign in with provider OAuth                        │
╰──────────────────────────────────────────────────────────╯
```

Views and interactions:

- **Provider detail** (Enter on a provider): keys with active marker;
  Enter on a key sets it active, `u` updates its key material, `d` deletes
  it (with a y/N confirm). Action rows add a key or edit family / base URL /
  visible model list, or remove the provider (confirmed).
- **Catalog add**: type-to-filter the models.dev catalog (◉ = already
  saved), Enter walks the same family/baseUrl/alias/label questions as
  `wstack auth`, with the API key entered masked.
- **Local server add**: pick a preset, confirm the base URL, the health
  probe runs (`GET /v1/models`) and discovered model ids are saved so the
  model picker works immediately.
- **OAuth sign-in**: pick a registry-provided strategy; the browser opens (or a
  device code is shown) and
  the flow's progress streams into the panel. Esc cancels cleanly (the
  loopback listener is torn down). If the browser can't redirect back,
  paste the redirect URL into the panel prompt.

All secrets stay CLI-side: the panel receives only masked key material, and
prompt input flows directly into the encrypted config
(the active profile config via the secret vault).

## Examples

```bash
/auth                           # TUI: open the panel · REPL: dashboard
/auth login                     # TUI: OAuth view · REPL: login hints
/auth status anthropic          # Text detail for one provider
```

## REPL dashboard output

```
API Keys — 3 providers

  anthropic               [anthropic] → anthropic 2 keys
  openai                   [openai] → openai 1 key
  google                   [gemini] → google no keys

  /auth status <id>  Detail    /auth open  Full menu
```

## Security

Keys are never displayed — only labels and masked status (`sk-a…f3k2`).
The `●` marker indicates the active key, `○` marks inactive keys. OAuth
warnings (subscription use outside official clients may violate provider
Terms) are shown before sign-in.

## Related

- `wstack auth` — same manager as a standalone terminal command
- `wstack auth <provider>` — direct add
- `wstack auth login <chatgpt|claude|copilot>` — scripted OAuth sign-in
- `wstack auth local --name <preset>` — scripted local-server add

## Code reference

- `packages/cli/src/slash-commands/auth.ts` — command + REPL fallback
- `packages/cli/src/auth-menu/panel-service.ts` — TUI panel host (flows bridge)
- `packages/tui/src/components/auth-panel.tsx` + `auth-panel-model.ts`
- `packages/tui/src/hooks/use-auth-panel.ts` — flow runner / prompt plumbing
- `packages/cli/src/provider-config-utils.ts`
