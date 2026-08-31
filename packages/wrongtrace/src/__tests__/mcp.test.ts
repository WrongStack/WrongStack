import { describe, expect, it } from "vitest";

import { createMcpTransport } from "../adapters/mcp.js";

describe("createMcpTransport", () => {
  it("invoke returns null for unknown tools and rejects fail open to null", async () => {
    const t = createMcpTransport({ lock_file: async () => ({ ok: true }) });
    expect(t.isWired).toBe(true);
    expect(await t.invoke("get_atlas", {})).toBeNull();
    const rejecting = createMcpTransport({
      unlock_file: async () => {
        throw new Error("MCP down");
      },
    });
    expect(await rejecting.invoke("unlock_file", { path: "x" })).toBeNull();
  });

  it("an empty tools bag is not wired and every invoke resolves null", async () => {
    const t = createMcpTransport();
    expect(t.isWired).toBe(false);
    expect(t.availableTools).toEqual([]);
    expect(await t.invoke("lock_file", { path: "x" })).toBeNull();
  });

  it("bounds a never-settling handler with the per-call timeout (fail-open null)", async () => {
    // Regression pin: invoke() must not await a hung MCP handler forever.
    // Every sibling transport bounds its awaits (httpJson 4s, ipc 2s/5s);
    // an unbounded MCP await would stall getFileHealth/lockFile and block
    // the edit path with no exception for the fail-open catch to see.
    const t = createMcpTransport(
      {
        lock_file: async () => new Promise<never>(() => {}),
      },
      150, // short bound for the test
    );
    const t0 = Date.now();
    const res = await Promise.race([
      t.invoke("lock_file", { path: "x" }).then((r) => ({ r })),
      new Promise<"BOUND">((resolve) => setTimeout(() => resolve("BOUND"), 1_000)),
    ]) as { r: unknown } | "BOUND";
    expect(res).not.toBe("BOUND");
    expect((res as { r: unknown }).r).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it("a fast handler still wins over the timeout", async () => {
    const t = createMcpTransport(
      { lock_file: async () => ({ ok: true, status: "locked" }) },
      1_000,
    );
    const res = await t.invoke<{ ok: boolean }>("lock_file", { path: "x" });
    expect(res?.ok).toBe(true);
  });

  it("clears the race timer when the handler settles first (no dangling timer)", async () => {
    // Regression pin (round 9): invoke() must clearTimeout its race timer on
    // the fast path — a dangling ref'ed setTimeout holds the event loop open
    // for the remaining timeoutMs and abandoned timers stack at higher call
    // rates. Verified live: pre-fix the loop drained 2004ms after a fast
    // invoke with a 2000ms bound; post-fix it drains in ~3ms.
    //
    // Diagnostic-API dependency: `process.getActiveResourcesInfo()` is a
    // diagnostic surface (stable since Node 17.3). Its "Timeout" resource
    // string is not part of a public promise — if a future Node renames it,
    // THIS pin and the repeated-call pin below turn spuriously red. That is
    // the intended failure mode (loud, self-explanatory) rather than a silent
    // regression; the assertion is delta-based (`<=` before/after) so vitest's
    // own runner timers are tolerated.
    const countTimeouts = () =>
      process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const t = createMcpTransport(
      { lock_file: async () => ({ ok: true, status: "locked" }) },
      10_000, // long bound: a leaked timer would be observably pending
    );
    const before = countTimeouts();
    const res = await t.invoke<{ ok: boolean }>("lock_file", { path: "x" });
    const after = countTimeouts();
    expect(res?.ok).toBe(true);
    expect(after).toBeLessThanOrEqual(before); // no NEW dangling timer
  });

  it("repeated fast invokes do not stack abandoned race timers", async () => {
    // Regression pin (review item #5): the single-call pin guards one invoke,
    // but the leak's compounding cost is at call rate — a dangling timer per
    // call would accumulate `count` pending Timeout resources after `count`
    // fast invokes on the same transport. 200 invokes with a 10s bound: any
    // timer not cleared in finally stays observably pending (the bound never
    // elapses in-test), so the resource count must not grow.
    const countTimeouts = () =>
      process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const t = createMcpTransport(
      { lock_file: async () => ({ ok: true, status: "locked" }) },
      10_000, // long bound: a leaked timer would be observably pending
    );
    const before = countTimeouts();
    const results: Array<{ ok: boolean } | null> = [];
    for (let i = 0; i < 200; i++) {
      results.push(await t.invoke<{ ok: boolean }>("lock_file", { path: `f${i}.ts` }));
    }
    const after = countTimeouts();
    expect(results.every((r) => r?.ok === true)).toBe(true); // all calls correct
    expect(after).toBeLessThanOrEqual(before); // no timer-stack growth at call rate
  });

  it("a handler rejecting AFTER the timeout branch wins is not an unhandled rejection", async () => {
    // Regression pin (round 9): Promise.race attaches its reactions to every
    // input promise at construction, so a handler that settles AFTER the
    // timeout branch won is already "handled" — its late rejection must never
    // surface as unhandledRejection. Guarded because a future refactor that
    // replaces the race with a manual timer could drop the handler reference
    // and regress exactly this.
    //
    // Deterministic (no wall-clock sleep): the handler's own reject callback
    // signals the moment the late rejection actually occurred; the test awaits
    // that signal (bounded in case the handler never rejects), then yields one
    // macrotask turn so any unhandledRejection emission is guaranteed to have
    // fired before asserting. Empirically probed pre-pin: NO unhandled
    // rejection observed (handler rejects 50ms after a 10ms bound).
    let signalRejected!: () => void;
    const handlerRejected = new Promise<void>((resolve) => {
      signalRejected = resolve;
    });
    const t = createMcpTransport(
      {
        lock_file: async () =>
          new Promise((_, reject) => {
            setTimeout(() => {
              reject(new Error("late bridge failure"));
              signalRejected(); // the rejection has actually occurred
            }, 50);
          }),
      },
      10, // timeout branch wins after 10ms
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    let boundTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const res = await t.invoke("lock_file", { path: "x" });
      expect(res).toBeNull(); // resolved by the timeout branch
      // Wait until the late rejection has REALLY happened — anchored to the
      // handler's own reject callback, not to an elapsed-sleep guess. Bounded
      // so a handler that never rejects fails loudly instead of hanging.
      const bound = new Promise<never>((_, reject) => {
        boundTimer = setTimeout(() => reject(new Error("late handler never rejected")), 2_000);
      });
      await Promise.race([handlerRejected, bound]);
      // unhandledRejection is emitted in the microtask drain following the
      // rejection; yielding one macrotask turn guarantees that drain ran.
      await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      if (boundTimer !== undefined) clearTimeout(boundTimer);
      process.off("unhandledRejection", onUnhandled);
    }
  });
});