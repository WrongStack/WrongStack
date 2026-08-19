# 07 — Writing a Third-Party Plugin

A complete, loadable WrongStack plugin in one file (`index.js`). It shows
every extension surface a plugin can join:

| Surface | Where in the example |
|---|---|
| Tools | `api.tools.register` → `example_word_count` |
| Lifecycle hooks | `api.registerHook('PostToolUse', 'write\|edit', …)` |
| Event bus | `api.onPattern('tool.*', …)` + `api.emitCustom('example-word-counter:…')` |
| Metrics | `api.metrics.counter/gauge` (auto-prefixed `plugin.<name>.…`) |
| Config center | `configSchema` + `defaultConfig` + `api.onConfigChange` hot-reload |
| Lifecycle | `teardown()` releasing every handle, `health()` for `/health` |

## Try it

From the repository root (registers a `path`-based config entry):

```bash
wstack plugin add ./examples/07-plugin
wstack plugin list          # shows "example-word-counter (external) enabled"
```

Start a session and ask the agent to count some words — the
`example_word_count` tool appears next to the built-in tools. Every
Write/Edit the agent performs is observed by the PostToolUse hook.

Because this is an **external** plugin, on first load the host pins a
SHA-256 of `index.js` into `~/.wrongstack/plugin-trust.json` (edit the file
and restart to see the refusal + `wstack plugin trust example-word-counter`
re-pin flow).

## Removing it

```bash
wstack plugin remove example-word-counter
```

## Next steps

- Authoring reference: `docs/plugin-author-guide.md`
- Packaging/publishing/trust: `docs/plugin-third-party.md`
- TypeScript SDK: `packages/plugin-sdk/README.md`
