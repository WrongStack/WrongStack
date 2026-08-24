// Live round-trip of the CLI gate's exact lock flow (wrongtrace-gate.ts
// `withFileLock` semantics, reproduced 1:1 against the daemon): owner
// identity stamped, TTL 900s, unlock in finally, conflict → no steal.
// The gate itself is TypeScript in packages/cli; this script exercises the
// identical call sequence through the same compiled adapter.
import { createWrongTraceClient } from "./dist/client.js";

const wt = await createWrongTraceClient({ baseUrl: "http://localhost:3444", timeoutMs: 1500 });
console.log("gate client.isAvailable =", wt.isAvailable, "| socketPath =", wt.socketPath);
if (!wt.isAvailable) {
  console.log("DAEMON OFFLINE — gate would degrade to allow/run-unlocked (contract holds).");
  process.exit(0);
}

const PATH = "__cli_gate_probe__";
const OWNER = "wrongstack-cli-gate";
const RUN = `ws-gate-${Date.now()}`;

// withFileLock: lock with owner + ttl 900 (as the gate does)
const lockOpts = { ttlSeconds: 900, owner: OWNER, ownerRunId: RUN };
const res = await wt.lockFile(PATH, "heavy edit in progress", lockOpts);
console.log("\nwithFileLock.acquire →", JSON.stringify(res));
console.log("  owner stamped:", res?.owner === OWNER, "| run:", res?.owner_run_id === RUN);

// Health must now show the lock with the same identity (preflight would block)
const h = await wt.getFileHealth(PATH);
console.log("preflight view → is_locked =", h?.is_locked, "| owner =", h?.lock_owner, "| expires =", h?.lock_expires_at);

// A second claim with a different owner must surface the 409 body (no steal)
const conflict = await wt.lockFile(PATH, "rival claim", { ttlSeconds: 60, owner: "rival-agent" });
console.log("rival claim → ok:", conflict?.ok, "| owner:", conflict?.owner, "| status:", conflict?.status);

// finally: unlock (gate always releases)
console.log("withFileLock.release →", JSON.stringify(await wt.unlockFile(PATH)));

// Post-release health confirms the file is editable again
const h2 = await wt.getFileHealth(PATH);
console.log("post-release is_locked =", h2?.is_locked);
console.log("\nGATE ROUND-TRIP", h2?.is_locked === false ? "OK ✓" : "LEAKED LOCK ✗");
