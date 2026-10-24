# @wrongstack/contracts

The shared vocabulary every WrongStack package builds against, split out of
`@wrongstack/core`:

- `@wrongstack/contracts/types` — messages, blocks, tools, providers, config,
  sessions, plugin API, ports (`*Port` interfaces) and the error classes.
- `@wrongstack/contracts/kernel` — the DI `Container`, `TOKENS`, `EventBus`
  and its event map, `Pipeline`, `RunController`.

Every module is also reachable by path (`@wrongstack/contracts/types/blocks`,
`@wrongstack/contracts/kernel/events`). Nothing here imports a Node built-in,
so browser bundles may depend on it; the only dependency is the browser-safe
`@wrongstack/primitives` subpaths.

`@wrongstack/core/types` and `@wrongstack/core/kernel` re-export this package
for existing importers.
