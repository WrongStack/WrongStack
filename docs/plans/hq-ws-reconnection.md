# HQ Dashboard WebSocket Reconnection Improvements

## Problem

The `HqWsClient` at `packages/webui-hq/src/lib/hq-ws-client.ts` has five issues:

1. **Double-close race** — `ws.onerror` calls `handleClose()`, then the browser fires `ws.onclose` which calls `handleClose()` again. Currently guarded by `reconnectTimer !== null`, but the timer could have already fired between the two calls (async gap).

2. **No heartbeat** — A TCP connection can go silent (idle timeout, half-open state) without the WebSocket `onclose` firing. The dashboard stays in "connected" state indefinitely until the OS TCP timeout (2h+ on some systems).

3. **No maxRetries** — In a server-down scenario (maintenance, crash loop), the client reconnects forever, burning battery/CPU with backoff that plateaus at 30s.

4. **No connection state** — Components like cockpit, fleet view cannot show a "Reconnecting..." indicator because there's no state signal. They only learn about disconnection when data stops arriving.

5. **No jitter** — `2^attempt * 1000` is deterministic. N dashboard tabs all reconnect at exactly the same second after a server restart.

## Design

### Connection States

```
DISCONNECTED → CONNECTING → CONNECTED
                    ↓              ↓ (on close / on error)
              RECONNECTING → DISCONNECTED
```

Expose as `HqWsConnectionState` type:
```ts
type HqWsConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';
```

### API Changes

```ts
class HqWsClient {
  // Existing
  connect(): void
  close(): void
  on(handler): () => void
  get isConnected(): boolean

  // New
  onStateChange(handler: (state: HqWsConnectionState) => void): () => void
  get state(): HqWsConnectionState

  // Configurable via constructor options
  constructor(opts?: {
    maxRetries?: number       // default: Infinity (current behavior)
    heartbeatIntervalMs?: number  // default: 25_000 (send ping every 25s)
    heartbeatTimeoutMs?: number   // default: 10_000 (close if no pong in 10s)
    maxBackoffMs?: number     // default: 30_000 (current cap)
  })
}
```

### Heartbeat Mechanism

- Server must send periodic `hq.pong` messages (already part of protocol)
- Client sends NO frames (WebSocket ping is browser-controlled)
- Client tracks: if no message received within `heartbeatIntervalMs + heartbeatTimeoutMs` (35s default), assume dead and reconnect
- Reset timer on every received message

### Reconnection Logic

```ts
private scheduleReconnect(): void {
  if (this.stopped || this.reconnectTimer !== null) return;
  if (this.reconnectAttempt >= this.maxRetries) {
    this.emitState('disconnected');
    return;
  }
  const base = 1000 * 2 ** Math.min(this.reconnectAttempt, 4);
  const jitter = base * (0.5 + Math.random() * 0.5); // 50-100% of base
  const delay = Math.min(jitter, this.maxBackoffMs);
  this.reconnectAttempt++;
  this.emitState('reconnecting');
  this.reconnectTimer = setTimeout(() => { ... }, delay);
}
```

### Double-Close Fix

In `handleClose()`, set `this.ws = null` and use a guard:
```ts
private handleClose(): void {
  if (this.ws === null) return; // already handled by onerror
  this.ws = null;
  this.scheduleReconnect();
}
```

Since `onerror` sets `ws = null` and calls `scheduleReconnect`, and `onclose` fires after `onerror`, the `ws === null` guard prevents double-scheduling.

### Connection State Emission

```ts
private emitState(state: HqWsConnectionState): void {
  this._state = state;
  for (const h of this.stateHandlers) h(state);
}
```

Called from:
- `connect()` → `'connecting'`
- `ws.onopen` → `'connected'`
- `handleClose()` → `'reconnecting'` (or `'disconnected'` if maxRetries exhausted)
- `close()` → `'disconnected'`

### State Visualization

In `packages/webui-hq/src/store.ts`, add a `connectionState` field to `HqState`. Wire `wsClient.onStateChange` to update it. Views read it from `useHqStore(['connectionState'])`.

## Files to change

| File | Change |
|---|---|
| `packages/webui-hq/src/lib/hq-ws-client.ts` | Add heartbeat, maxRetries, jitter, state events, double-close fix |
| `packages/webui-hq/src/lib/hq-ws-client.test.ts` | **NEW** — unit tests |
| `packages/webui-hq/src/store.ts` | Wire connection state into store |
| `packages/webui-hq/src/views/cockpit.tsx` | Show reconnection indicator |

## Acceptance Criteria

1. ✅ Client detects silent connection dropout within 35s and reconnects
2. ✅ Exponential backoff with jitter prevents reconnect storms
3. ✅ After `maxRetries` (default Infinity) is hit, stops reconnecting
4. ✅ `onerror` + `onclose` double-fire does not cause double reconnect
5. ✅ State changes propagate to React components via store subscription
6. ✅ Existing `isConnected` and handler API unchanged (backwards compatible)
7. ✅ Unit tests cover: connect/disconnect/reconnect, heartbeat timeout, maxRetries, double-close, state transitions

## Edge Cases

- **Page visibility** (tab hidden): Browsers throttle timers. Heartbeat timer runs late but normal message delivery resets it, so no false timeout during hidden state.
- **Rapid connect/close/connect**: `stopped` flag and `ws !== null` guard prevent races.
- **Server sends malformed JSON**: Already handled (`try/catch` in `onmessage`).
- **Multiple tabs**: Each tab runs its own client — no coordination needed.
- **Token expires**: If token expires mid-session, `close()` should be called explicitly from outside.
