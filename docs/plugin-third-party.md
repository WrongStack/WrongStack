# Third-Party Plugin Guide

Packaging, publishing, distributing, and maintaining plugins for WrongStack
as an external author. For the plugin contract itself (hooks, tools, config
schemas) read [plugin-author-guide.md](./plugin-author-guide.md); this
document covers everything around it.

---

## Package naming

- Recommended: `wstack-plugin-<name>` or `@your-scope/wstack-plugin-<name>`.
- The npm package name and the plugin's declared `name` field do not have to
  match, but keeping them aligned makes trust messages and config entries
  easier to reason about.
- Plugin names must not collide with built-in plugin names (the host refuses
  an external plugin that declares a built-in's name) and must be non-empty
  strings.

## Dependencies

Depend on exactly one host package:

```json
{
  "dependencies": {
    "@wrongstack/plugin-sdk": "^0.308.0"
  }
}
```

The SDK is types + `definePlugin` + the runtime helper module. Do not depend
on `@wrongstack/core` or `@wrongstack/plugins` — those are the host's
internal surface and give you nothing the SDK doesn't.

Ship compiled JavaScript (`dist/`) with `"type": "module"` and a default
export. Keep the entry small; the host hashes the **entry file** for trust
pinning, so a single stable entry (that re-exports the rest) produces the
least pin churn for users.

## apiVersion strategy

The host kernel exposes a plugin contract version (`KERNEL_API_VERSION`,
currently `0.1.10`). Declare the range you tested against:

```ts
import { definePlugin } from '@wrongstack/plugin-sdk';

export default definePlugin({ name: 'wstack-plugin-x', /* … */ }, async (api) => {
  /* … */
});
```

`definePlugin` pins `^0.1` automatically. The host rejects a plugin whose
declared range no longer satisfies the kernel (`PLUGIN_API_MISMATCH`), so:

- `^0.1` — loads across all additive 0.1.x contract changes (recommended).
- Exact `0.1.10` — pin only if you depend on a surface added in that
  specific version and want to fail loudly elsewhere.

Check the [changelog](../CHANGELOG.md) for `KERNEL_API_VERSION` bumps;
contract-breaking bumps are called out explicitly.

## Config schema

Declare `configSchema` (JSON Schema) and `defaultConfig` so the host
validates the user's `config.extensions.<name>` section **before** your
`setup()` runs. Per-field metadata controls reload and redaction behaviour:

```ts
configFields: {
  apiToken: { lifecycle: 'immutable', secret: true, description: 'Service token' },
  pollIntervalMs: { lifecycle: 'hot' },
}
```

- `hot` — safe to read again on `api.onConfigChange` without restart.
- `restart` — takes effect on next boot.
- `immutable` — changing it requires an explicit reconfigure.
- `secret: true` — redacted from diagnostics and config diffs.

## Publishing checklist

1. `name` and `version` set; `description` is one line (shown in
   `wstack plugin list` output when configured).
2. `apiVersion` declared (or use `definePlugin`).
3. `capabilities` declared honestly — external plugins are **strictly
   enforced**: calling `api.tools.register` without `capabilities.tools`
   being true rejects the plugin at setup.
4. `configSchema` covers every option you read; defaults in `defaultConfig`.
5. `teardown()` releases every registration (`tools.unregister`, hook
   handles, event unsubscribes, timers, child processes). The host gives
   teardown 10 s, then logs and moves on — leaked handles outlive that.
6. No top-level side effects beyond cheap constants: module code runs on
   import, before the loader calls `setup`.
7. `postinstall` scripts: users install with `--ignore-scripts` by default
   (`wstack plugin add --install` passes it unless the user opts into
   `--run-scripts`). Ship prebuilt JS; don't rely on install-time builds.
8. Test against a real host: `wstack plugin add ./dist` in a scratch project,
   then check `wstack plugin report` and the boot log for capability or
   trust warnings.

## How users install your plugin

```bash
wstack plugin add wstack-plugin-x            # register only (user installs the package themselves)
wstack plugin add wstack-plugin-x --install  # install into ~/.wrongstack/plugins via npm/pnpm/yarn/bun
```

Or manually in `~/.wrongstack/profiles/<profile>/config.json`:

```json
{
  "plugins": [
    { "name": "wstack-plugin-x", "path": "~/.wrongstack/plugins/node_modules/wstack-plugin-x" }
  ]
}
```

Project-local development: drop the package under
`<project>/.wrongstack/plugins/<name>/` (inactive by default — enable it
explicitly) or register `{ "name", "path": "./relative/path" }` in the
project config.

## The trust model (what your users see)

On first load the host pins a SHA-256 of your plugin's entry file. When you
publish a new version, users see:

```
[plugins] REFUSING external plugin "wstack-plugin-x" — its entry file changed
since it was first trusted (pinned 2026-08-01T…). If you expected this
update, re-pin it: wstack plugin trust wstack-plugin-x
```

This is by design (it is the only supply-chain signal for in-process
plugins). Document it in your README so updates don't generate bug reports.
`features.pluginsTrust: false` disables pinning for users who accept the risk.

## Distribution channels

- **npm** is the primary channel (`--install` support).
- **Direct paths** (`path` config entries and the discovery directories) work
  for private/internal plugins — no registry involved.
- There is no plugin marketplace today; a registry/marketplace is future work
  and would build on the same `path` + trust primitives.
