# Module-by-module audit

A bottom-up sweep of every workspace package: performance, memory, resource
lifecycle, business logic, and trust boundaries. One module at a time, one
commit per module, findings recorded here so the campaign survives a context
reset.

## Order

Modules are audited in dependency order — a defect in a leaf package reproduces
in every consumer, so fixing it first stops the same finding being written five
times at higher layers.

| Layer | Packages |
| --- | --- |
| L0 | `persistence`, `governance` |
| L1 | `kanban` |
| L2 | `core` (per `src/` subdirectory) |
| L3 | `tools`, `providers`, `mcp`, `sage`, `plugins`, `acp`, `techstack`, `telegram`, `security-scanner`, `requirement-intake`, `plug-lsp`, `bench` |
| L4 | `runtime`, `sdd`, the `*-mcp` adapters |
| L5 | `webui-server`, `webui`, `webui-hq`, `simpleui`, `tui` |
| L6 | `cli` |

## Method

Each module is taken on its own, with its boundary stated before any reading:

1. **Boundary** — public API, upstream dependencies, downstream consumers.
2. **Read** — every source file, hotspots (`architecture/hotspots.json`) first.
3. **Five axes**
   - *Memory*: uncapped collections, retained listeners, timers, caches, spools.
   - *CPU*: quadratic passes, repeated parsing, polling, synchronous I/O on hot paths.
   - *Business logic*: boundary conditions, races, idempotency, state-machine transitions.
   - *Resource lifecycle*: `dispose`/`close`/`drain` on every exit path, including failure.
   - *Trust*: which inputs are untrusted, and where that boundary is enforced.
4. **Fix and cover** — every confirmed finding gets a regression test that fails
   without the fix.
5. **Close** — package tests, `tsc --noEmit`, and `biome lint` green.

A finding is only recorded once it is demonstrated, not once it looks plausible.

## Status

See [`ledger.md`](./ledger.md).
