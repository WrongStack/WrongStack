/**
 * Focused LIVE verification of the CLI WrongTrace gate
 * (src/wiring/wrongtrace-gate.ts) against the running daemon on
 * localhost:3444.
 *
 * What this proves end-to-end:
 *   - withFileLock() acquires the daemon lock with the caller's owner
 *     identity stamped, releases it in finally
 *   - the lock is visible to peers while held (listLocks carries owner)
 *   - preflightFileEdit() reports `blocked` for a file held by another
 *     owner, and `allow` once released
 *   - a conflicting second withFileLock does NOT steal the file (runs
 *     unlocked rather than force-taking the peer's lock)
 *
 * Daemon-offline tolerance: the gate is a soft dependency. When
 * WrongTrace is down every assertion degrades to allow/no-op — so this
 * suite detects that state up-front and skips the lock assertions
 * instead of flaking.
 */

import { afterAll, describe, expect, it } from "vitest";

import {
  getWrongTrace,
  preflightFileEdit,
  resetWrongTraceGate,
  withFileLock,
} from "../src/wiring/wrongtrace-gate.js";

const PROBE = `__cli_gate_probe_${Date.now()}__`;

afterAll(() => {
  resetWrongTraceGate();
});

describe("CLI wrongtrace-gate (live daemon)", () => {
  it("gate warms up; records whether the daemon is reachable for this run", async () => {
    const wt = await getWrongTrace();
    if (!wt.isAvailable) {
      console.warn("[wrongtrace-gate.live] daemon offline — lock assertions will be skipped");
    }
    expect(typeof wt.isAvailable).toBe("boolean");
  });

  it("withFileLock stamps owner identity and releases the lock in finally", async () => {
    const wt = await getWrongTrace();
    const observedOwner: string[] = [];

    const result = await withFileLock(
      PROBE,
      "focused live gate verification",
      async () => {
        // While held, the lock must be visible to peers with our identity.
        const locks = await wt.listLocks();
        const mine = locks.find((l) => l.path === PROBE);
        if (mine) observedOwner.push(mine.owner ?? "");
        return "edit-done";
      },
      { owner: "cli-gate-live-test", ownerRunId: "cli-gate-verify" },
    );

    expect(result).toBe("edit-done");

    if (!wt.isAvailable) return; // offline: everything above is no-op by design
    expect(observedOwner).toContain("cli-gate-live-test");

    // Released afterwards.
    const after = (await wt.listLocks()).filter((l) => l.path === PROBE);
    expect(after).toHaveLength(0);
  });

  it("preflightFileEdit blocks a file held by another owner, allows once released", async () => {
    const wt = await getWrongTrace();
    if (!wt.isAvailable) {
      expect((await preflightFileEdit(PROBE)).kind).toBe("allow");
      return;
    }

    await wt.lockFile(PROBE, "held by a peer", {
      owner: "peer-agent",
      ttlSeconds: 60,
    });

    const blocked = await preflightFileEdit(PROBE);
    expect(blocked.kind).toBe("blocked");
    if (blocked.kind === "blocked") {
      expect(blocked.risk.band).toBe("locked");
      expect(blocked.risk.reasons.join(" ")).toContain("peer-agent");
    }

    await wt.unlockFile(PROBE);
    const allowed = await preflightFileEdit(PROBE);
    expect(allowed.kind).toBe("allow");
  });

  it("a conflicting withFileLock runs the body without stealing the peer's lock", async () => {
    const wt = await getWrongTrace();
    if (!wt.isAvailable) return;

    await wt.lockFile(PROBE, "held by a peer", { owner: "peer-agent", ttlSeconds: 60 });

    // Second claimant: conflict body (ok:false) — gate must NOT force-take.
    const result = await withFileLock(
      PROBE,
      "conflicting claim",
      async () => "ran-unlocked",
      { owner: "second-agent", ttlSeconds: 30 },
    );
    expect(result).toBe("ran-unlocked");

    // Peer's lock survives untouched.
    const held = (await wt.listLocks()).find((l) => l.path === PROBE);
    expect(held?.owner).toBe("peer-agent");

    await wt.unlockFile(PROBE);
  });
});
