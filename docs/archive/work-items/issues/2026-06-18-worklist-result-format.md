# Decide canonical worklist result format: `key.operation_result` vs `ok`/`error`

**Filed:** 2026-06-18
**Status:** Open
**Priority:** Medium
**Effort estimate:** 1–2 hours (decision + migration)
**Risk:** Low — both formats are functionally equivalent; this is a consistency decision

## Problem

After extracting shared worklist handlers into `@wrongstack/webui/server/handlers`
(PRs ca0fb1e8, 8e6935ad), two WebSocket result formats are now in active use:

### Format A — `key.operation_result` (CLI embedded server)
```typescript
// packages/cli/src/webui-server/ws-handlers/worklist.ts
sendResult(ws, true, `Todo "${title}" created.`);
sendResult(ws, false, 'Todo not found.');
```
Used by: `todos.add`, `todos.remove`, `todos.update`

The `sendResult(ws, ok, message)` helper sends:
```json
{ "type": "key.operation_result", "key": "<handler-key>", "payload": { "ok": true, "message": "..." }}
```

### Format B — `ok` / `error` (shared handlers, standalone server)
```typescript
// packages/webui/src/server/handlers/worklist-handlers.ts
ctx.send(ws, { type: 'ok', key: 'todos.cleared', payload: {} });
ctx.send(ws, { type: 'error', key: 'todos.cleared', error: 'Not found.' });
```
Used by: `todos.cleared`, `tasks.*`, `plan.*` (all shared handlers)

## Why this matters

1. **The CLI's worklist handlers cannot fully delegate to shared handlers today.**
   Because `handleTodosAdd`, `handleTodosRemove`, `handleTodosUpdate` use
   `key.operation_result` (format A) but the shared module produces `ok`/`error`
   (format B), the CLI keeps these three handlers inline rather than calling the
   shared versions. This is the last remaining obstacle to the CLI fully adopting
   the shared handler module.

2. **The client must handle both formats.** The WebUI client (`useToolCall` hook)
   has two code paths for processing worklist results — one for `key.operation_result`,
   one for `ok`/`error`. The duplication in the client mirrors the duplication in
   the server.

3. **Format B (`ok`/`error`) is the better default** because:
   - It is explicit: `ok` and `error` are self-documenting.
   - It is the pattern already established in `@wrongstack/webui/server/ws-utils.ts`
     (`send` and `broadcast` accept `object`, and the convention is `{ type, key, payload }`
     or `{ type, key, error }`).
   - It is the format used by all other shared handlers (`file-handlers.ts`,
     `context-handlers.ts`, etc.).

## Decision required

Choose one canonical format:

| Option | Change | Who sends it |
|--------|--------|--------------|
| **A** (`key.operation_result`) | Migrate shared handlers to use `sendResult` | CLI handlers + shared handlers |
| **B** (`ok`/`error`) | Migrate CLI inline handlers to call shared handlers | All handlers |

**Recommended: Option B.** The shared handler module is the canonical location
for worklist logic. Migrating CLI handlers to shared → `key.operation_result` dies
naturally as the dead code path.

## Migration plan (if Option B is chosen)

1. Update `WorklistContext` in `packages/webui/src/server/handlers/worklist-handlers.ts`
   to accept an optional `format?: 'ok' | 'operation_result'` parameter so the CLI
   can call shared handlers with `format: 'operation_result'` during transition.
2. Or: add a `formatResult(ws, ok, message)` helper to `ws-utils.ts` that sends
   `key.operation_result` (format A), and have the CLI's wrapper call the shared
   handler, then convert the result via this helper.
3. Update the WebUI client `useToolCall` hook to drop the `key.operation_result`
   code path once all worklist results come through the shared handlers.

The cleanest path: keep the shared handlers as-is (format B), update the CLI's
`handleTodosAdd/Remove/Update` to call the shared handlers (which now return format B),
and update the WebUI client to handle format B for todo operations.

## Files affected

| File | Change |
|------|--------|
| `packages/webui/src/server/handlers/worklist-handlers.ts` | No change (already format B) |
| `packages/cli/src/webui-server/ws-handlers/worklist.ts` | Delegate `todos.add/remove/update` to shared handlers; update response format |
| `packages/webui/src/client/hooks/use-tool-call.ts` | Remove `key.operation_result` code path for todo operations |

## Out of scope

- `file-handlers.ts`, `context-handlers.ts`, `brain-handlers.ts` — already use format B
- The standalone server (`packages/webui/src/server/index.ts`) — already uses format B via shared handlers
