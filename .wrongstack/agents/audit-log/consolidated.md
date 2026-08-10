## Audit-Log Role: Learned Practices

### Memory-Boundedness Audits

- **Every module-scope `Map`/`Set` in long-lived host processes must have a matching delete site, not just an initial clear in the shutdown path.** Before reporting a structure as "bounded," locate and quote the cleanup site that fires during normal operation.
- **Map the known cleanup patterns per host process** so audits are systematic rather than ad-hoc:
  - `packages/cli/src/hq-server/` — `ws.ts` close handlers for clients/browsers; age sweeps in `hq-server.ts` around lines 243–252; `evictOldest` helper in `utils.ts` for transcripts/agentMessages; splice caps for `eventLog`/`commandQueue`.
- **Flag Maps whose only lifecycle event is a final clear on server close.** Example: `mailboxGateways` in `hq-server.ts` had no per-entry eviction and must be marked as a retention risk, not as bounded.
- **Standard evidence format for a bounded structure:** state the map name, the module, and the exact cleanup function/line that evicts entries during steady-state operation. Without that citation, do not certify it.

### WrongStack Frontend (`packages/webui/`)

- **Every `Map`-backed suppression/echo/coalescer must carry either a TTL sweep or a per-key array cap.** Deletion only on consume is insufficient.
- **Concrete risk shape:** `suppressedChatEchoes` in `packages/webui/src/lib/ws-client.ts` accumulates per-key arrays that grow unbounded under sustained silent-response failures because `consumeSuppressedChatEcho` is the sole release point.
- **Required remediation pattern when a consume-only delete is in place:** add either a reconnect-time prune of all per-key arrays, or an explicit per-key cap inside the structure. Verify the chosen mechanism is wired before closing the audit item.

### Audit Reporting Conventions

- Tie every retention claim to a named code site; never assert "bounded" or "unbounded" in the abstract.
- Distinguish steady-state eviction from shutdown-only clear — these are different risk profiles.
- Prefer listing the exact cleanup function name (`evictOldest`, `consumeSuppressedChatEcho`, etc.) over describing the behavior in prose, so future audits can grep for the same names.