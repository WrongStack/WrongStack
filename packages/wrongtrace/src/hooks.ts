/**
 * WrongTrace guardrail hooks — shared by every host that executes tools.
 *
 * Originally lived in `@wrongstack/cli/wiring`; moved here so the CLI
 * leader, fleet subagents, the standalone WebUI server, and runtime-package
 * light subagents register the identical gate without cross-importing each
 * other. These are STRUCTURAL functions: they deliberately avoid an
 * `@wrongstack/core` dependency (the adapter package stays decoupled from
 * every runtime inside WrongStack), so hosts register them on their own
 * `HookRegistry` and the structural parameter types accept core's richer
 * `HookInput`.
 *
 * Behaviour:
 *   preToolUse:  resolve the target path from toolInput; run the
 *                WrongTrace pre-flight (health + lock state). A file
 *                locked by ANOTHER owner DENIES the call with the
 *                owner/expiry in the reason — the model sees it and can
 *                pick another file. A lock owned by THIS session is
 *                treated as available (self-owner exemption) so the
 *                acquire-in-pre/release-in-post pairing stays usable —
 *                a leaked own lock (executor denied/threw before postToolUse)
 *                never blocks the session's own retry. Healthy/fragile/
 *                offline daemons ALLOW; fragile files additionally get a
 *                one-line "prefer surgical edits" nudge via additionalContext.
 *                On allow we also ACQUIRE the daemon lock for the edit
 *                (owner = session id) so peers see the claim.
 *   postToolUse: release the lock acquired in preToolUse (path-keyed).
 *                The daemon TTL is the leak backstop if execution never
 *                completes.
 *
 * Concurrency: lock bookkeeping is scoped PER HOOK PAIR (per runner), not
 * process-global, and reference-counted. A shared module-level map would let
 * one executor's postToolUse release another executor's active lock when the
 * same path is claimed by two in-process runners. `createWrongTraceHookPair`
 * allocates its own counter map; it is also safe to share ONE pair across
 * concurrent executors (standalone WebUI parent + SDD-wizard workers, or the
 * fleet runner across subagents) — overlapping claims increment the count and
 * the daemon lock is only released when the LAST finisher's postToolUse
 * decrements it to zero.
 *
 * Failure philosophy: COORDINATION optimization, never a hard dependency.
 * Daemon offline → everything allows. Any throw inside the hooks must be
 * swallowed by the caller-side catch below so a slow daemon (timeout) can
 * never add latency surprises to the edit path.
 */

import { getWrongTrace, preflightFileEdit } from "./gate.js";

/**
 * Structural subset of the host's `HookInput` this hook actually reads.
 * Core's `HookInput` (and any host equivalent carrying `toolName` +
 * `toolInput`) is structurally assignable to this, which is what lets the
 * same factory serve every host without a framework dependency here.
 */
export interface WrongTraceHookInput {
  toolName?: string | undefined;
  toolInput?: unknown;
}

/** Mutually-exclusive pre-flight verdict, mirroring core's contract. */
export type WrongTracePreToolUseOutcome =
  | { action: "allow"; additionalContext?: string | undefined }
  | { action: "deny"; reason: string };

/**
 * Typed gate-decision events emitted by the hooks when a host supplies an
 * `emit` callback. One event per decision point — denied edit, fragile
 * nudge, lock acquired / race-lost / released. Hosts map these onto their
 * EventBus (e.g. `events.emit('wrongtrace.gate.decision', e)`); the
 * adapter itself stays transport-agnostic.
 */
export type WrongTraceGateDecisionEvent =
  | { kind: "deny"; path: string; reason: string }
  | { kind: "allow-fragile"; path: string; reasons: readonly string[] }
  | { kind: "lock-acquired"; path: string; owner: string }
  | { kind: "lock-conflict-race"; path: string }
  | { kind: "lock-released"; path: string };

/** Tools that mutate a single target file and must pass the gate. */
const EDIT_TOOLS = new Set([
  "edit",
  "write",
  "replace",
  "patch",
  "codebase-ast-replace",
]);

/**
 * Extract the target file path from a mutating tool's input, if present.
 *
 * Order matters: `file` (codebase-ast-replace) MUST come before any
 * selector-ish field — `target` is the body/full AST selector, never a
 * path, so it must not be treated as one. Multi-file inputs resolve to
 * their first concrete file; `patch` has no single derivable target (the
 * diff payload names its own files), so its optional `directory` is the
 * coarsest honest claim and a bare `patch` input (no directory) yields
 * `undefined` → gate allows without a claim.
 */
function targetPathOf(toolInput: unknown): string | undefined {
  if (!toolInput || typeof toolInput !== "object") return undefined;
  const t = toolInput as Record<string, unknown>;
  // Single-file keys: edit/write → `path`, codebase-ast-replace → `file`.
  for (const key of ["path", "file_path", "file"]) {
    const v = t[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  // `replace` accepts files: string | string[].
  const files = t["files"];
  if (typeof files === "string" && files.length > 0) return files;
  if (Array.isArray(files) && files.length > 0) {
    const first = files[0];
    if (typeof first === "string" && first.length > 0) return first;
  }
  // `patch` accepts an optional directory.
  const dir = t["directory"];
  if (typeof dir === "string" && dir.length > 0) return dir;
  return undefined;
}

/** Emit a gate-decision event without ever letting a throw escape. */
function emitSafe(
  emit: ((event: WrongTraceGateDecisionEvent) => void) | undefined,
  event: WrongTraceGateDecisionEvent,
): void {
  try {
    emit?.(event);
  } catch {
    // Observability must never break the edit path.
  }
}

export interface WrongTraceHookPair {
  /** Pre-flight + claim. Denies when another owner holds the file. */
  preToolUse: (
    input: WrongTraceHookInput,
    runtime?: unknown,
  ) => Promise<WrongTracePreToolUseOutcome | undefined>;
  /** Release the lock claimed by `preToolUse` for the same path. */
  postToolUse: (input: WrongTraceHookInput) => Promise<void>;
}

export interface WrongTraceHookOptions {
  /** Typed gate-decision event sink (host maps it onto its EventBus). */
  emit?: (event: WrongTraceGateDecisionEvent) => void;
}

/**
 * Per-runner lock bookkeeping. Reference-counted: when one hook pair is
 * shared across concurrent executors (standalone WebUI parent + SDD-wizard
 * workers, or the fleet runner across subagents), overlapping claims on the
 * same path increment the count and the daemon lock is only released when
 * the LAST finisher's postToolUse decrements it to zero — a sibling finishing
 * early can never unlock a path another in-flight edit still holds.
 */
export function newWrongTraceLockCounter(): Map<string, number> {
  return new Map<string, number>();
}

function acquireLock(counters: Map<string, number>, path: string): void {
  counters.set(path, (counters.get(path) ?? 0) + 1);
}

function releaseLock(
  counters: Map<string, number>,
  path: string,
  onZero: () => void,
): void {
  const next = (counters.get(path) ?? 1) - 1;
  if (next > 0) {
    counters.set(path, next);
    return;
  }
  counters.delete(path);
  onZero();
}

/**
 * Create a pre/post hook PAIR sharing one per-runner reference-counted lock
 * map. Every host should use this when wiring both phases: the pairing
 * guarantees `postToolUse` only releases locks this exact pair's
 * `preToolUse` claimed (see concurrency note at the top of this file), and
 * the reference count keeps the daemon lock held while any sibling executor
 * sharing the pair still has the path in flight.
 */
export function createWrongTraceHookPair(
  sessionId: () => string,
  opts: WrongTraceHookOptions = {},
  counters: Map<string, number> = newWrongTraceLockCounter(),
): WrongTraceHookPair {
  const emit = opts.emit;

  return {
    async preToolUse(input, _runtime) {
      if (!EDIT_TOOLS.has(input.toolName ?? "")) return undefined;
      const path = targetPathOf(input.toolInput);
      if (!path) return undefined;

      try {
        // Self-owner exemption: OUR OWN held lock (leaked by an interrupted
        // earlier edit) must not deny this session's retry. lock_owner from
        // the daemon's file-health response is compared against this pair's
        // owner identity by preflightFileEdit.
        const verdict = await preflightFileEdit(path, `wrongstack:${sessionId()}`);
        if (verdict.kind === "blocked") {
          const owner = verdict.risk.reasons.join("; ");
          emitSafe(emit, { kind: "deny", path, reason: `WrongTrace lock: ${owner}` });
          return { action: "deny", reason: `WrongTrace lock: ${owner}` };
        }

        // Allow — and claim the lock so peers see this edit in flight.
        const wt = await getWrongTrace();
        if (wt.isAvailable) {
          const owner = `wrongstack:${sessionId()}`;
          const res = await wt.lockFile(path, "WrongStack edit in progress", {
            owner,
            ttlSeconds: 900,
          });
          if (res?.ok === true) {
            acquireLock(counters, path);
            emitSafe(emit, { kind: "lock-acquired", path, owner });
          } else {
            // Peer grabbed it between the pre-flight and the claim (or our
            // own earlier leak still holds it — the exemption let us through).
            // Either way the file is being edited by someone: we proceed
            // without re-claiming; coordination stays advisory.
            emitSafe(emit, { kind: "lock-conflict-race", path });
          }
        }

        if (verdict.risk && verdict.risk.band === "fragile") {
          emitSafe(emit, { kind: "allow-fragile", path, reasons: verdict.risk.reasons });
          return {
            action: "allow",
            additionalContext: `WrongTrace: ${path} is fragile (${verdict.risk.reasons.join("; ")}). Prefer surgical AST diffs over rewrites.`,
          };
        }
        return { action: "allow" };
      } catch {
        // Fail-open: coordination must never break the edit path.
        return undefined;
      }
    },

    async postToolUse(input) {
      if (!EDIT_TOOLS.has(input.toolName ?? "")) return;
      const path = targetPathOf(input.toolInput);
      // Only release a lock THIS pair claimed — a shared (module-level) map
      // would let one executor free another's active lock. Reference counts:
      // the daemon unlock happens only when the LAST sibling release lands.
      if (!path || !counters.has(path)) return;
      let shouldUnlock = false;
      releaseLock(counters, path, () => {
        shouldUnlock = true;
      });
      if (!shouldUnlock) return; // a sibling still holds this path
      emitSafe(emit, { kind: "lock-released", path });
      try {
        const wt = await getWrongTrace();
        if (wt.isAvailable) await wt.unlockFile(path);
      } catch {
        // TTL backstop will reap it.
      }
    },
  };
}

// ── Legacy single-phase factories ─────────────────────────────────────────
// Old consumers register pre/post separately. They share the module-level
// reference-counted lock map, preserving the historical behaviour; new code
// should use `createWrongTraceHookPair` (per-runner scoping) instead.
//
// IMPORTANT: paired and legacy hooks use SEPARATE counters — a legacy
// postToolUse can never release a paired pair's claim (and vice versa). Do
// not mix the two styles for the same path in one process: the intended
// release would no-op and the daemon TTL would reap the lock.

const legacyLocks = newWrongTraceLockCounter();

export function createWrongTracePreToolUseHook(
  sessionId: () => string,
  opts?: WrongTraceHookOptions,
) {
  return createWrongTraceHookPair(sessionId, opts, legacyLocks).preToolUse;
}

export function createWrongTracePostToolUseHook(opts?: WrongTraceHookOptions) {
  return createWrongTraceHookPair(() => "", opts, legacyLocks).postToolUse;
}