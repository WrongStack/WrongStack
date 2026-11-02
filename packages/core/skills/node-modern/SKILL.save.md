# Modern Node.js (Compact)

<!-- source-version: 2.1.5 -->

## Selection card
- Task: Node runtime APIs, ESM and async cancellation. / TR: Node çalışma zamanı API, ESM ve async iptal.
- Start: Read package.json (type, engines, exports, scripts) and the Node version the project actually runs on.
- Finish: The code runs on the target Node version with cancellation, errors and cleanup handled, and type checks and tests pass.

## Overview

Node.js 26.13.0 (newest stable; LTS 26.13.0 since 2026-10-28, Node 24 in maintenance; checked 2026-11-02) ships natively what older code pulled from npm:
native TypeScript type stripping (`node file.ts`), native `.env`
loading (`node --env-file`), built-in SQLite (`node:sqlite`), global WebSocket,
`Promise.withResolvers()`, global fetch, `AbortSignal.timeout`, `node:test`, Web Streams,
and `node --run`. Prefer the platform when its semantics fit; do not remove needed capabilities merely to reduce dependency count.

## Rules

1. **Pre-flight: Inspect repo runtime & live Node.js LTS schedule first.** Check `package.json`
   `"engines"`, `.nvmrc`, `.node-version`, and check `node -v` to determine the active engine.
   Check the official Node.js release schedule online to ensure target runtime aligns with
   active LTS or the requested latest stable channel; verify support status from the current release schedule.
2. Match the module system. In an ESM package (`"type": "module"` or `.mjs`)
   write ES `import` statements, with explicit file extensions on relative imports when the
   project compiles with NodeNext. Don't convert a CommonJS package to ESM as a
   side effect of another change.
3. Import built-ins with the `node:` prefix (`node:fs/promises`, `node:path`, `node:sqlite`).
3. Prefer native platform features over npm bloat:
   - Use native `node --env-file=.env` instead of installing `dotenv`.
   - Use native `globalThis.fetch()` instead of `axios` or `node-fetch`.
   - Native WebSocket covers standard clients; verify the required client/server features before replacing ws.
   - Use native `node:sqlite` for local structured caching and data storage.
   - Use native `node:crypto` `randomUUID()` instead of `uuid`.
   - Use `Promise.withResolvers()` instead of hand-rolled deferred promises.
4. Give every operation that can wait a deadline: pass an `AbortSignal` to
   fetch calls, child processes, and timers; combine user cancellation with a
   timeout using `AbortSignal.any`.
5. Handle `ENOENT` by reading inside try/catch and branching on `err.code`;
   checking `access` first is a race (TOCTOU).
6. Never block the event loop in a server or CLI hot path: no `*Sync` fs calls
   or CPU-heavy loops on request paths.
7. Pass arguments to child processes as an array (`execFile`/`spawn`), never by
   interpolating into a shell string.
8. Every promise is awaited, returned, or explicitly handled; let entry points
   report unhandled rejections instead of swallowing them.

## Detailed workflow

Load the full node-modern skill before relying on its specialized modes,
references or output contracts. Its current SKILL.md is the source of truth;
this compact body does not expand task scope or authorization.

## Before returning

- [ ] Module system and Node version match what the project declares
- [ ] Built-ins imported with `node:`; no new dependency the platform covers
- [ ] Every network call, child process, and delay is cancellable or bounded
- [ ] Child-process arguments passed as arrays
- [ ] Missing-file and abort cases handled deliberately; no floating promises
