import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWrongTraceHookPair } from "../hooks.js";
import { resetWrongTraceGate } from "../gate.js";

/**
 * Hermetic hook-pair contract tests. Overrides globalThis.fetch with a stub
 * daemon and drives preToolUse/postToolUse end to end; asserts the typed
 * gate-decision events (deny / allow-fragile / lock-acquired /
 * lock-conflict-race / lock-released) emitted by the pair.
 *
 * Regression focus: lock-released is emitted ONLY on a confirmed daemon
 * unlock (released !== null && released.ok !== false), mirroring
 * lock-acquired's confirmed-emission rule — a failed unlock must not record
 * a release the daemon never performed.
 */

function makeFetch(responder: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return responder(url, init);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function healthyHealth(): Response {
  return jsonResponse({ status: "ok", socket_path: "" }); // IPC unwired
}

function healthyFileHealth(): Response {
  return jsonResponse({ path: "", health_score: 100, is_fragile: false, recent_thrashing_count: 0, is_locked: false });
}

describe("createWrongTraceHookPair gate events", () => {
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    resetWrongTraceGate();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it("emits lock-acquired and lock-released on a confirmed acquire+release cycle", async () => {
    let unlockCalls = 0;
    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/health") return healthyHealth();
      if (u.pathname === "/api/file/health") return healthyFileHealth();
      if (u.pathname === "/api/guardrail/lock") return jsonResponse({ ok: true, path: "", status: "locked" });
      if (u.pathname === "/api/guardrail/unlock") {
        unlockCalls++;
        return jsonResponse({ ok: true, path: "src/foo.ts", status: "unlocked" });
      }
      return jsonResponse({});
    });

    const events: string[] = [];
    const pair = createWrongTraceHookPair(() => "sess-test", { emit: (e) => events.push(e.kind) });

    const pre = await pair.preToolUse({ toolName: "edit", toolInput: { path: "src/foo.ts" } });
    expect(pre).toEqual({ action: "allow" });
    await pair.postToolUse({ toolName: "edit", toolInput: { path: "src/foo.ts" } });

    expect(unlockCalls).toBe(1);
    expect(events).toContain("lock-acquired");
    expect(events).toContain("lock-released");
  });

  it("does NOT emit lock-released when the daemon unlock fails (HTTP 503 → null)", async () => {
    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/health") return healthyHealth();
      if (u.pathname === "/api/file/health") return healthyFileHealth();
      if (u.pathname === "/api/guardrail/lock") return jsonResponse({ ok: true, path: "", status: "locked" });
      if (u.pathname === "/api/guardrail/unlock") return new Response("boom", { status: 503 });
      return jsonResponse({});
    });

    const events: string[] = [];
    const pair = createWrongTraceHookPair(() => "sess-test", { emit: (e) => events.push(e.kind) });

    await pair.preToolUse({ toolName: "edit", toolInput: { path: "src/foo.ts" } });
    await pair.postToolUse({ toolName: "edit", toolInput: { path: "src/foo.ts" } });

    expect(events).toContain("lock-acquired");
    expect(events).not.toContain("lock-released");
  });

  it("does NOT emit lock-released when the daemon returns ok:false on unlock (409 conflict body)", async () => {
    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/health") return healthyHealth();
      if (u.pathname === "/api/file/health") return healthyFileHealth();
      if (u.pathname === "/api/guardrail/lock") return jsonResponse({ ok: true, path: "", status: "locked" });
      if (u.pathname === "/api/guardrail/unlock") {
        return jsonResponse({ ok: false, status: "conflict", error: "not ours" }, 409);
      }
      return jsonResponse({});
    });

    const events: string[] = [];
    const pair = createWrongTraceHookPair(() => "sess-test", { emit: (e) => events.push(e.kind) });

    await pair.preToolUse({ toolName: "edit", toolInput: { path: "src/foo.ts" } });
    await pair.postToolUse({ toolName: "edit", toolInput: { path: "src/foo.ts" } });

    expect(events).toContain("lock-acquired");
    expect(events).not.toContain("lock-released");
  });

  it("does NOT emit lock-released when the daemon is offline at postToolUse", async () => {
    let offline = false;
    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/health") return healthyHealth();
      if (u.pathname === "/api/file/health") return healthyFileHealth();
      if (u.pathname === "/api/guardrail/lock") return jsonResponse({ ok: true, path: "", status: "locked" });
      if (u.pathname === "/api/guardrail/unlock") {
        offline = true;
        throw new Error("ECONNREFUSED");
      }
      return jsonResponse({});
    });

    const events: string[] = [];
    const pair = createWrongTraceHookPair(() => "sess-test", { emit: (e) => events.push(e.kind) });

    await pair.preToolUse({ toolName: "edit", toolInput: { path: "src/foo.ts" } });
    await pair.postToolUse({ toolName: "edit", toolInput: { path: "src/foo.ts" } });

    expect(offline).toBe(true);
    expect(events).toContain("lock-acquired");
    expect(events).not.toContain("lock-released");
  });

  it("skips the daemon entirely while a sibling still holds the path (refcount 2→1)", async () => {
    let unlockCalls = 0;
    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/health") return healthyHealth();
      if (u.pathname === "/api/file/health") return healthyFileHealth();
      if (u.pathname === "/api/guardrail/lock") return jsonResponse({ ok: true, path: "", status: "locked" });
      if (u.pathname === "/api/guardrail/unlock") {
        unlockCalls++;
        return jsonResponse({ ok: true });
      }
      return jsonResponse({});
    });

    // Pre-seeded refcount 2: one sibling is still editing — this release
    // must only decrement, never hit the daemon, never emit.
    const counters = new Map<string, number>([["src/foo.ts", 2]]);
    const events: string[] = [];
    const pair = createWrongTraceHookPair(() => "sess-test", { emit: (e) => events.push(e.kind) }, counters);

    await pair.postToolUse({ toolName: "edit", toolInput: { path: "src/foo.ts" } });

    expect(unlockCalls).toBe(0);
    expect(events).not.toContain("lock-released");
    expect(counters.get("src/foo.ts")).toBe(1);
  });

  it("does NOT let a lock-conflict-race release a sibling's active claim (refcount participant)", async () => {
    // Regression pin: a racer whose preToolUse failed to acquire counts as
    // an in-flight PARTICIPANT — its own postToolUse decrements its own
    // entry, so a sibling finishing early can never release the daemon lock
    // another executor's edit still holds. The owner-guard then verifies
    // the lock belongs to this session before the LAST finisher unlocks.
    let lockCalls = 0;
    let unlockCalls = 0;
    const OWNER = "wrongstack:sess-test";
    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/health") return healthyHealth();
      if (u.pathname === "/api/file/health") {
        return jsonResponse({ path: "src/foo.ts", health_score: 100, is_fragile: false, recent_thrashing_count: 0, is_locked: true, lock_owner: OWNER });
      }
      if (u.pathname === "/api/guardrail/lock") {
        lockCalls++;
        if (lockCalls === 1) return jsonResponse({ ok: true, path: "src/foo.ts", status: "locked", owner: OWNER });
        return jsonResponse({ ok: false, status: "conflict", error: "already locked", owner: OWNER }, 409);
      }
      if (u.pathname === "/api/guardrail/unlock") {
        unlockCalls++;
        return jsonResponse({ ok: true, path: "src/foo.ts", status: "unlocked" });
      }
      return jsonResponse({});
    });

    const events: string[] = [];
    const pair = createWrongTraceHookPair(() => "sess-test", { emit: (e) => events.push(e.kind) });

    await pair.preToolUse({ toolName: "edit", toolInput: { path: "src/foo.ts" } }); // A acquires
    await pair.preToolUse({ toolName: "edit", toolInput: { path: "src/foo.ts" } }); // B races
    await pair.postToolUse({ toolName: "edit", toolInput: { path: "src/foo.ts" } }); // B finishes first

    expect(lockCalls).toBe(2); // A acquired, B raced
    expect(unlockCalls).toBe(0); // B must NOT release A's claim
    expect(events).toContain("lock-acquired");
    expect(events).toContain("lock-conflict-race");
    expect(events).not.toContain("lock-released");

    await pair.postToolUse({ toolName: "edit", toolInput: { path: "src/foo.ts" } }); // A finishes last

    expect(unlockCalls).toBe(1); // the LAST finisher releases exactly once
    expect(events).toContain("lock-released");
  });
});