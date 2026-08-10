# 05 — MCP Client and Protocol Layer

**Package:** `@wrongstack/mcp`
**Files examined:** `client.ts` (1012 lines), `registry.ts` (1032 lines), `authorization.ts` (835 lines)
**Assessment:** Three medium and one low defects found and resolved; lifecycle, registry, and authorization review complete

---

## 1. MCP Client: Child Process Lifecycle

**File:** `packages/mcp/src/client.ts`, lines 598-654

The `close()` method handles child process shutdown with a graceful-then-forced escalation:

```typescript
// Line 612: Initial SIGTERM
child.kill();

// Line 621-624: Race graceful exit vs timeout
const gracefulRace = await Promise.race([
  exitPromise.then(() => 'exited' as const),
  new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), GRACEFUL_MS)),
]);

// Line 625-635: Escalate to SIGKILL on timeout
if (gracefulRace === 'timeout') {
  forceKillTree(child);
  await Promise.race([
    exitPromise,
    new Promise<void>((resolve) => setTimeout(resolve, FORCE_TIMEOUT_MS)),
  ]);
}
```

### A-17: Windows graceful shutdown targeted the command wrapper (Medium)

Windows stdio servers are launched through a `cmd.exe` shim. The original graceful step called `child.kill()`, which targets that wrapper rather than delivering shutdown to the real MCP server. If the wrapper exited first, the subsequent process-tree escalation could also lose its live root PID and leave the actual server orphaned.

**Resolution (2026-08-10):** Windows now closes the protocol stdin stream first. EOF reaches the real MCP server and gives it the standard stdio graceful-shutdown contract while keeping the wrapper tree rooted. If the server remains alive after 800 ms, `forceKillTree` removes the still-rooted tree with `taskkill /T /F`. POSIX retains direct SIGTERM followed by SIGKILL.

The resulting escalation is:
1. stdin EOF on Windows or SIGTERM on POSIX (800ms grace period)
2. `forceKillTree` if still alive (POSIX: SIGKILL, Windows: `taskkill /T /F`)
3. Wait up to 1200ms more for exit confirmation
4. Clean up listeners and drop references for GC

**Finding (Verified Good):** The TOCTOU race at line 602-609 is explicitly handled:
```typescript
child.once('exit', () => resolve());
if (child.exitCode !== null || child.signalCode !== null) resolve();
```
The listener is registered first, then the exit code is checked. This prevents the case where the child exits between the check and the listener registration.

**Validation:** Two real Windows subprocess fixtures verify both branches: a cooperative MCP server records stdin EOF and exits gracefully, while a server that ignores EOF and owns a live descendant is force-terminated with no surviving descendant. The focused lifecycle run passed **54/54** and the complete MCP package passed **594/594 across 32 files**; MCP typecheck passed.

---

## 2. MCP Client: Pending Request Management

**File:** `packages/mcp/src/client.ts`, lines 656-700

The `request` method manages pending JSON-RPC requests with per-request timeouts:

```typescript
const id = this.nextId++;
const req: JsonRpcRequest = { jsonrpc: '2.0', id, method, params };
return new Promise((resolve, reject) => {
  const onAbort = signal ? () => {
    const pending = this.pending.get(id);
    this.pending.delete(id);
    if (pending) clearTimeout(pending.timer);
    void this.notify('notifications/cancelled', { requestId: id, reason: 'client aborted' })
      .catch(() => {});
    reject(new AbortError(...));
  } : undefined;
  ...
});
```

**Verified:** Abort support follows the MCP cancellation spec (`notifications/cancelled`). The pending entry is cleaned up, the timeout timer is cleared, and a best-effort cancellation notification is sent.

**Finding (Low):** The `onAbort` function sends `notifications/cancelled` which is a best-effort notification. If the server has already processed and sent the response, the notification arrives late and the response is orphaned. The `detach` function (called on resolution) should handle this by ignoring responses for already-deleted pending entries.

---

## 3. MCP Client: Transport Abstraction

**File:** `packages/mcp/src/client.ts`, lines 663-667

```typescript
if (this.sseTransport) return this.sseTransport.request(method, params, timeoutMs, opts);
if (this.httpTransport) return this.httpTransport.request(method, params, timeoutMs, opts);
```

**Verified:** The client supports three transports: stdio, SSE, and streamable-HTTP. Each transport has its own request method that handles the full round-trip including timeout and abort.

**Finding (Verified Good):** The `close()` method at line 650-653 closes transports in order:
```typescript
this.failPending(`MCP "${this.opts.name}" closed`);
this.sseTransport?.close();
this.httpTransport?.close();
```

Pending requests are failed before transports are closed. This is correct for HTTP transports (in-flight requests are not in `this.pending`). But for stdio, the `failPending` call happens while the child process is still alive (the child was killed at line 612). If the child sends a response between `failPending` and the transport close, it arrives after the pending entry was deleted — this is safe because the response handler checks for the pending entry.

---

## 4. MCP Registry

**File:** `packages/mcp/src/registry.ts` (1032 lines)

The registry manages MCP server configurations, lifecycle, and tool discovery.

### A-10: Lossy MCP tool-name normalization could hide tools (Medium)

MCP tools are namespaced as `mcp__<server>__<tool>`, so ordinary MCP names cannot collide with built-ins. However, the provider-wire sanitizer replaced every unsupported character with `_` and truncated the combined name to 128 characters. Distinct identities such as `search:messages` and `search.messages`, or two long server names sharing the same prefix, therefore produced the same registry name. `ToolRegistry.register()` correctly rejected the duplicate, but the later remote tool became unavailable.

**Resolution (2026-08-10):** Safe, short names retain their existing stable form. Server or tool segments that require lossy normalization or truncation now receive a deterministic SHA-256 identity suffix, with the server segment bounded separately so the complete name and `mcpServerToolPrefix()` remain consistent inside the 128-character wire limit. Regressions cover punctuation collisions, server collisions, truncation, ordinary-name compatibility, wrapper execution, and `mcp_use` resolution.

### Targeted-review disposition

- **Built-in collisions:** MCP names remain under the `mcp__` namespace. The central `ToolRegistry` rejects duplicates rather than overriding an existing tool; collision-safe qualification now prevents lossy MCP-to-MCP aliases as well.
- **Live tool-list propagation:** `notifications/tools/list_changed` refreshes the client's cache, unregisters the prior wrapper set, registers the new set, updates lazy manifests, and bumps the shared ToolRegistry version. Agent requests read `listForProvider()` from that live registry, so later iterations observe the change. A registry regression verifies the old executable disappears and the new executable becomes available.
- **Reconnect configuration:** The registry reconnects the existing server slot and rebuilds `MCPClient` from the unchanged `slot.cfg`. Transport, command/URL, headers, environment, timeouts, `allowedTools`, permission, lazy mode, and authorization factory inputs are preserved. The integration restart regression now verifies both the allowlist and permission after reconnection.
- **Bounds:** Reconnect cycles, retry delays, listeners, pending requests, catalog pages/items, manifests, operation samples, and idle timers are explicitly bounded.

---

## 5. MCP Authorization

**File:** `packages/mcp/src/authorization.ts` (835 lines)

The production flow was traced through discovery, authorization request creation, manual callback completion, token exchange, encrypted persistence, refresh, registry wiring, and disconnect behavior.

### A-11: OAuth authorization responses were not bound to the discovered issuer (Medium)

The client validated the metadata document's `issuer`, PKCE state, callback URI, and token audience, but it did not validate the authorization response's `iss` parameter. Because WrongStack can interact with multiple dynamically discovered authorization servers, malicious metadata could combine an honest authorization endpoint with an attacker-controlled token endpoint and cause an honest authorization code to be submitted to the attacker (OAuth authorization-server mix-up).

**Resolution (2026-08-10):** Authorization-server metadata now records RFC 9207 issuer-response support. Cross-origin authorization/token endpoints are accepted only when that support is advertised; the returned callback must then contain exactly one `iss` value matching the discovered issuer before the code is exposed. Same-origin endpoint deployments retain compatibility without requiring `iss`. Callback `state`, `code`, `error`, and `iss` parameters are also checked for duplicate or contradictory values.

### A-12: Concurrent discovery bypassed the pending-session bound (Low)

The 32-session limit counted only completed discovery results. Thirty-two or more simultaneous, distinct `begin()` calls could therefore all pass the check before any entry reached the pending map. A concurrent `disconnect()` also could not cancel an in-flight discovery, allowing the supposedly disconnected session to reappear afterward.

**Resolution (2026-08-10):** In-flight discoveries now reserve capacity, duplicate starts for the same server/resource are rejected, and disconnect invalidates the matching attempt. Intentional restart of an already pending session remains supported, and the old session is retained if replacement discovery fails.

### Defensive controls verified

- Protected-resource and authorization-server metadata are fetched without redirects, with DNS resolution pinned to the connected address and private-address rejection outside exact loopback development resources.
- Metadata resource and issuer identifiers use exact canonical matching; discovery requires advertised PKCE `S256` support.
- Authorization requests use 256-bit random state and PKCE verifier values; callback URI components and state are verified before a one-shot code exchange.
- Token requests include the exact MCP `resource`; bearer tokens are audience-bound, bounded, expiry-checked, and never sent through query parameters.
- Stored tokens are encrypted through the host vault, atomically persisted under a file lock with restrictive permissions, and bounded by file size and entry count.
- Refresh is single-flight per live provider; rotating refresh tokens returned by the server replace the prior stored value.

---

## Summary

The MCP client is well-designed with careful attention to process lifecycle, abort handling, and transport abstraction. Key findings:

1. **Windows graceful shutdown** — wrapper-targeting defect resolved; real graceful and descendant-cleanup fixtures pass
2. **Transport ordering** — pending request failure vs transport close is correct but subtle
3. **Registry tool identity** — lossy normalization collision resolved with stable hash suffixes
4. **Authorization issuer binding** — mix-up defense and ambiguous callback rejection added
5. **Authorization concurrency** — discovery now participates in the bounded pending lifecycle

The reviewed stdio lifecycle and OAuth authorization path contain explicit lifecycle, SSRF, PKCE, audience, issuer, persistence, replay, and concurrency controls. Comparative transport maturity still requires live interoperability measurements rather than source inspection alone.
