# 07 — WebUI Server: WebSocket Handlers

**Package:** `@wrongstack/webui-server`
**Files examined:** `worktree-ws-handler.ts`, `sdd-board-ws-handler.ts`, `goal-ws-handler.ts` (959 lines), `http-server.ts` (1167 lines), `setup-events.ts` (1036 lines), `collaboration-ws-handler.ts` (926 lines), `connections-health-route.ts` (1226 lines)
**Assessment:** Complete for the audited HTTP/WS boundary; one low hardening and one medium origin-auth defect resolved

---

## 1. Intervals Without unref() — Defensive Shutdown Hardening

**File:** `packages/webui-server/src/server/worktree-ws-handler.ts`, line 501

```typescript
private ensureBroadcast(): void {
  this.broadcast(this.stateMessage());
  if (this.broadcastInterval) return;
  this.broadcastInterval = setInterval(() => this.broadcast(this.stateMessage()), 2000);
}
```

**Finding A-03 (Low):** The `setInterval` at line 501 does **not** call `.unref()`. An active interval can keep the event loop alive if normal lifecycle cleanup is missed. The reviewed handler has both `dispose()` and empty-handle paths that call `stopBroadcast()`, so this is defense in depth rather than a confirmed shutdown failure.

**Resolution (2026-08-10):** Added `unref()` to the worktree, goal, collaboration, and setup-event status intervals while preserving their existing explicit cleanup paths.

**Same pattern found in:**
- `sdd-board-ws-handler.ts` line 337: `this.poll = setInterval(...)` — this one **does** call `.unref()` (line 337: `this.poll.unref?.()`) ✅
- `goal-ws-handler.ts` line 790-794: `this.broadcastInterval = setInterval(...)` — fixed with `.unref()` ✅
- `collaboration-ws-handler.ts` line 612-616: broadcast interval — fixed with `.unref()` ✅
- `setup-events-status-watcher.ts` line 45-47: optional metrics interval — fixed with `.unref()` ✅

**Impact:** Low. The reviewed dispose/completion paths clear these timers, and the server normally has other live handles. `unref()` prevents a missed disposer from making a timer the last remaining process handle.

**Applied fix:** Add `.unref()` to all reviewed `setInterval` calls in WS handlers:
```typescript
this.broadcastInterval = setInterval(() => this.broadcast(this.stateMessage()), 2000);
this.broadcastInterval.unref();
```

---

## 2. Worktree WS Handler: Path Validation

**File:** `packages/webui-server/src/server/worktree-ws-handler.ts`, lines 280-293

```typescript
if (branch && !MANAGED_BRANCH_RE.test(branch)) { ... return; }
if (dir && !this.underRoot(dir)) { ... return; }
if (branch && this.liveActiveBranches().has(branch)) { ... return; }
```

**Verified:** The handler validates:
1. Branch names must match a managed branch regex (prevents git flag injection)
2. Directories must be under the project root (prevents arbitrary directory access)
3. Live branches are protected from cleanup/merge (prevents race conditions with running agents)

**Finding (Verified Good):** The `MANAGED_BRANCH_RE` regex check at line 280 is a critical security control — without it, a malicious WebSocket client could pass `--upload-pack` or other git flags as a "branch name." The regex ensures only valid branch name characters are accepted.

---

## 3. SDD Board WS Handler: Polling Architecture

**File:** `packages/webui-server/src/server/sdd-board-ws-handler.ts`, lines 334-344

```typescript
private startPolling(): void {
  if (!this.standalonePollingEnabled || this.poll !== null || this.clients.size === 0) return;
  this.poll = setInterval(() => void this.pollLatest(), 1000);
  this.poll.unref?.();
}
```

**Verified:** The polling starts only when:
1. Standalone polling is enabled
2. No poll is already running
3. At least one client is connected

The `.unref()` call ensures the interval doesn't keep the process alive. The `pollInFlight` flag (line 330) prevents overlapping polls.

**Finding (Verified Good):** This is well-designed — polling only runs when needed, doesn't overlap, and doesn't block process exit.

---

## 4. Goal WS Handler: State Broadcasting

**File:** `packages/webui-server/src/server/goal-ws-handler.ts`, lines 788-802

```typescript
private startBroadcast(): void {
  if (this.broadcastInterval) return;
  this.broadcastInterval = setInterval(() => {
    const progress = this.orchestrator?.getProgress();
    if (progress) this.broadcast({ type: 'goal.progress', payload: progress });
    this.broadcastState();
  }, 2000);
}
```

### A-18: Goal broadcast rescanned the serialized frame per client (Low)

The 2-second broadcast interval calls both `getProgress()` and `broadcastState()`. A 1K/10K-task and 1/100-client benchmark found that state projection itself remained small and near-linear (0.027 ms mean at 1K tasks; 0.345 ms at 10K), but 10K-task fan-out rose from 5.67 ms for one client to 48.64 ms for 100 clients. The shared frame was serialized once, yet `sendSerialized()` recomputed its UTF-8 byte length for every client, repeatedly scanning the same multi-megabyte string for backpressure accounting.

**Resolution (2026-08-10):** Broadcast paths now compute the serialized frame size once and pass it to each per-client send. The 10K-task/100-client mean fell to 4.91 ms, essentially equal to the one-client 5.07 ms result. A 100-client regression asserts one byte-length computation per fan-out. Focused handler/utility tests passed **79/79**, the complete WebUI server suite passed **1,536/1,536 across 134 files**, and typecheck passed.

The measured 10K-task projection plus serialization remains about 5 ms every two seconds after the fan-out fix. Adding a state hash would still traverse/serialize the same graph and would complicate the periodic board-state tap contract, so change-only broadcasting is not justified by the measured cost.

---

## 5. Goal WS Handler: Board State Tap

**File:** `packages/webui-server/src/server/goal-ws-handler.ts`, lines 810-819

```typescript
if (this.onBoardState) {
  try {
    this.onBoardState(this.graph.id, state);
  } catch (err) {
    this.logger.error(
      `[Goal] board-state tap failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
```

**Verified:** The board state tap (which syncs goal state to a kanban board) is wrapped in try/catch. A mirror error never breaks the live broadcast. This is the correct defensive pattern for a best-effort side effect.

---

## 6. HTTP and WebSocket Security Boundary

**File:** `packages/webui-server/src/server/http-server.ts` (1167 lines)

The deferred security review was completed across `http-server.ts`, `ws-auth.ts`, connection lifecycle/decoding, API body readers, and their focused tests.

**Verified — HTTP CSRF/CORS posture:** Every request passes a Host/Origin boundary before routing. Loopback binds reject non-loopback Host headers (DNS rebinding), browser Origins must match the request authority or an operator allowlist, opaque `Origin: null` is rejected, and non-loopback binds require the shared token. Write bodies use JSON content types and bounded readers. The server does not grant wildcard CORS response access.

**Verified — token handling:** Token comparison is constant-time for equal-length values. Browser bootstrap exchanges the one-shot query token for an HttpOnly, SameSite=Strict, Path=/ cookie; secure deployments use `Secure` plus the `__Host-` prefix. Ordinary API routes do not accept query tokens off-loopback. Static responses set CSP, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, and a referrer policy.

**Finding A-16 (Medium, WebSocket authorization):** The WebSocket policy described its loopback bootstrap as same-origin, but compared only effective ports after proving both hostnames were loopback. `http://localhost:3456` could therefore open a tokenless socket whose Host was `127.0.0.1:3456`. On public/wildcard binds, any browser Origin presenting the valid cookie was accepted without comparing Origin to Host. Browser cookies are not port-bound and SameSite is not a same-origin control, so a sibling host or same-host process on another port could drive the WebSocket control plane with the automatically attached HttpOnly cookie.

**Resolution (2026-08-10):** Loopback bootstrap now requires the same normalized hostname and effective port. Cookie-authenticated browser sockets on token-required/public binds must also match the exact request authority; the existing cross-port loopback development escape hatch remains explicit. Separate public-WS hosts retain the already explicit allowlisted URL-token path. Regressions cover loopback aliases, public sibling hosts, same-host different ports, and the opt-in development path.

**Verified — resource controls:** WebSocket frames are capped at 20 MiB. Decoded work messages are limited to 600 per connection per 60 seconds by default (keepalives excluded; `WEBUI_RATE_LIMIT=0` is the explicit opt-out). HTTP JSON readers reviewed here cap bodies at route-appropriate sizes, including 64 KiB for session message APIs, 512 KiB for requirement intake, and 10 MiB for dead-code scan input. No rate-limit or unbounded-body defect was confirmed.

---

## 7. WS Payload Validation

**File:** `packages/webui-server/src/server/ws-payload-validation.ts` (949 lines)

**Verified at the transport boundary:** Every inbound frame passes through `decodeProtocolFrame(raw, 'client')` before dispatch. The decoder rejects unsafe object keys and excessive nesting, and the connection lifecycle applies the per-client rate budget after decode. Route-specific validators then constrain privileged or structured payloads. This does not mean every business invariant lives in one validator, but the earlier claim that validation wiring was unestablished is now closed.

---

## 8. Connections Health Route

**File:** `packages/webui-server/src/server/connections-health-route.ts` (1226 lines)

**Finding (Low):** At 1226 lines, this is the largest file in the webui-server package. It handles connection health monitoring, which is inherently complex (timeouts, heartbeats, reconnection, cleanup). The size suggests a comprehensive implementation.

---

## Validation

- WebSocket auth, HTTP server, auth-cookie hardening, payload validation, and dispatcher suites: **200/200 passed across 5 files**.
- Full WebUI-server suite: **1,535/1,535 passed across 134 files**. One preceding run exposed a transient Fleet control-test failure; the isolated file passed 6/6 and subsequent full reruns were clean.
- WebUI server production-source TypeScript check passed.
- Scoped Biome check passed for the production auth change; `git diff --check` passed.

## Summary

Two actionable defects are resolved: reviewed long-lived status intervals no longer keep the process alive by themselves (A-03), and browser WebSocket cookie/bootstrap authentication is now bound to the exact request authority (A-16). HTTP Host/Origin enforcement, token handling, security headers, frame/body bounds, decoded-message rate limiting, payload decoding, worktree path controls, polling overlap prevention, and board-tap error isolation were verified. Goal-state change detection remains an unmeasured optimization candidate, not a correctness finding; large file sizes remain maintainability observations only.
