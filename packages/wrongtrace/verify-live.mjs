/**
 * One-shot live verification script for the WrongTrace integration.
 * Run with:  node .\\verify-live.mjs
 * (after `pnpm --filter @wrongstack/wrongtrace build`, OR import the TS via tsx).
 *
 * What it verifies (against the LIVE daemon):
 *   1. HTTP discovery probe (/api/health → socket_path).
 *   2. JSON-RPC 2.0 method matrix on the daemon pipe — result envelopes,
 *      error envelopes, and per-method latency. Also probes the methods
 *      the v0.3.3 changelog claims were added to IPC (guardrail/atlas):
 *      treat what the pipe actually answers as the source of truth.
 *   3. Client end-to-end: discover → isAvailable → IPC-first routing
 *      (getFileHealth / reportTelemetry over the pipe) → HTTP-only routes.
 *   4. IPC vs HTTP latency comparison for file_health.
 *   5. Guardrail lock/unlock round-trip over HTTP (cleanup guaranteed).
 */
import net from "node:net";
import { createWrongTraceClient } from "./dist/client.js";
import { defaultSocketPath } from "./dist/discovery.js";

const BASE = process.env.WRONGTRACE_URL ?? "http://localhost:3444";

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Raw JSON-RPC 2.0 call over Named Pipe / UDS, \n-framed. Mirrors adapters/ipc.ts. */
function rpc(socketPath, method, params, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const sock = net.connect(socketPath);
    const id = Math.floor(Math.random() * 1e6);
    let buffer = "";
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, error: { code: -1, message: `timeout after ${timeoutMs}ms` } }), timeoutMs);
    sock.once("connect", () => sock.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`));
    sock.on("data", (d) => {
      buffer += d.toString("utf8");
      let newlineAt = buffer.indexOf("\n");
      while (newlineAt !== -1) {
        const line = buffer.slice(0, newlineAt).trim();
        buffer = buffer.slice(newlineAt + 1);
        newlineAt = buffer.indexOf("\n");
        if (line.length === 0) continue;
        let envelope;
        try {
          envelope = JSON.parse(line);
        } catch {
          continue;
        }
        if (envelope.id === id || envelope.error) done({ ok: !envelope.error, ...envelope });
      }
    });
    sock.on("error", (err) => done({ ok: false, error: { code: -1, message: err.code ?? err.message } }));
  });
}

async function http(method, path, body) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(2500),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json, ms: round2(performance.now() - t0) };
}

const PAD = 30;
const fmtMs = (ms) => `${String(round2(ms)).padStart(6)} ms`;

// ── 1) HTTP discovery probe ────────────────────────────────────────────────
console.log("── 1) HTTP /api/health (discovery probe) ─────────────────");
const health = await http("GET", "/api/health");
console.log(`HTTP ${health.status} in ${fmtMs(health.ms)}`);
console.log("body =", JSON.stringify(health.body));
const socketPath = health.body?.socket_path ?? defaultSocketPath();
console.log("socket_path =", socketPath);

// ── 2) JSON-RPC 2.0 method matrix on the pipe ──────────────────────────────
console.log("\n── 2) JSON-RPC 2.0 method matrix (daemon pipe) ───────────");
const matrix = [
  ["telemetry/file_health", { file_path: "package.json" }],
  ["telemetry/report_run", { run_id: "verify-live", agent_name: "wrongstack", model_name: "verify", provider: "verify", prompt_tokens: 1, completion_tokens: 1, cost_usd: 0.0001, intent: "verify-live.mjs run" }],
  // v0.3.3 claims these are now IPC-active; the pipe's answer is truth.
  ["guardrail/lock", { path: "verify-live/probe", owner: "verify-live", reason: "capability probe", ttl_seconds: 30 }],
  ["guardrail/unlock", { path: "verify-live/probe" }],
  ["get_atlas", { summary: true }],
];
const liveIpcMethods = new Set();
for (const [method, params] of matrix) {
  const t0 = performance.now();
  const res = await rpc(socketPath, method, params);
  const ms = performance.now() - t0;
  if (res.ok) {
    liveIpcMethods.add(method);
    console.log(`  ✓ ${method.padEnd(PAD)} ${fmtMs(ms)}  result=${JSON.stringify(res.result).slice(0, 90)}`);
  } else {
    console.log(`  ✗ ${method.padEnd(PAD)} ${fmtMs(ms)}  error=${res.error.code} ${res.error.message.slice(0, 70)}`);
  }
}
if (liveIpcMethods.has("guardrail/lock")) {
  const cleanup = await rpc(socketPath, "guardrail/unlock", { path: "verify-live/probe" });
  console.log(`  ↺ lock probe cleaned: ${cleanup.ok ? "ok" : cleanup.error.message}`);
}

// ── 2b) IPC lock conflict enforcement probe ────────────────────────────────
// The integration letter promises -32009 on conflict. HTTP returns a
// structured 409. This probe checks whether the PIPE enforces conflicts:
// acquire over HTTP, attempt a conflicting IPC lock with force:false, then
// verify ownership over HTTP. A result envelope + changed owner = silent
// takeover (daemon bug) — the reason client.ts keeps lockFile HTTP-first.
console.log("\n── 2b) IPC lock conflict enforcement (force:false) ───────");
let lockConflictEnforced = null;
if (liveIpcMethods.has("guardrail/lock") && liveIpcMethods.has("guardrail/unlock")) {
  const PROBE = "verify-live/conflict-probe";
  try {
    // 1) acquire over HTTP
    const httpLock = await http("POST", "/api/guardrail/lock", {
      path: PROBE, owner: "verify-live-http", reason: "conflict probe seed", ttl_seconds: 30,
    });
    console.log(`  seed HTTP lock      : ${httpLock.status} owner=${httpLock.body?.owner ?? "?"}`);
    // 2) conflicting IPC lock, force:false
    const ipcAttempt = await rpc(socketPath, "guardrail/lock", {
      path: PROBE, owner: "verify-live-ipc", reason: "conflict probe attempt", ttl_seconds: 30, force: false,
    });
    const rejected = ipcAttempt.ok !== true; // ok:false = error envelope (e.g. -32009)
    console.log(`  IPC conflicting lock: ${rejected ? `REJECTED ✓ (${ipcAttempt.error.code} ${ipcAttempt.error.message.slice(0, 60)})` : "ACCEPTED (result envelope)"}`);
    // 3) who owns it now, over HTTP?
    const locksRes = await http("GET", "/api/guardrail/locks");
    const current = (Array.isArray(locksRes.body) ? locksRes.body : []).find((l) => l.path === PROBE);
    console.log(`  current owner (HTTP): ${current?.owner ?? "(none)"}`);
    lockConflictEnforced = rejected && current?.owner === "verify-live-http";
    console.log(
      lockConflictEnforced
        ? "  VERDICT: conflict ENFORCED on the pipe — client.ts lockFile can be flipped to IPC-first."
        : "  VERDICT: conflict NOT enforced (silent takeover) — client.ts lockFile stays HTTP-first (see strategy header).",
    );
  } finally {
    const rel = await rpc(socketPath, "guardrail/unlock", { path: "verify-live/conflict-probe" });
    if (!rel.ok) await http("POST", "/api/guardrail/unlock", { path: "verify-live/conflict-probe" });
    console.log("  ↺ probe lock released");
  }
} else {
  console.log("  (skipped — guardrail methods not live on this pipe)");
}

// ── 3) Client end-to-end (dist build) ──────────────────────────────────────
console.log("\n── 3) createWrongTraceClient() end-to-end (dist) ─────────");
const wt = await createWrongTraceClient({ baseUrl: BASE, timeoutMs: 1500 });
console.log("isAvailable =", wt.isAvailable, "| baseUrl =", wt.baseUrl, "| socketPath =", wt.socketPath);
const fh = await wt.getFileHealth("package.json");
console.log("getFileHealth   →", JSON.stringify(fh)?.slice(0, 120));
const rt = await wt.reportTelemetry({
  run_id: "verify-live", agent_name: "wrongstack", model_name: "verify", provider: "verify",
  prompt_tokens: 1, completion_tokens: 1, cost_usd: 0.0001, intent: "verify-live.mjs run",
});
console.log("reportTelemetry →", JSON.stringify(rt));
const atlas = await wt.getAtlas({ summary: true });
console.log("getAtlas(IPC-first) →", atlas ? `ok, ${atlas.packages?.length ?? 0} packages` : "null");
const lock = await wt.lockFile("verify-live/probe", "verify-live capability probe", { owner: "verify-live", ttlSeconds: 30 });
console.log("lockFile(HTTP)  →", JSON.stringify(lock)?.slice(0, 120));
const unlock = await wt.unlockFile("verify-live/probe");
console.log("unlockFile(HTTP)→", JSON.stringify(unlock)?.slice(0, 120));

// ── 4) IPC vs HTTP latency for file_health ─────────────────────────────────
console.log("\n── 4) IPC vs HTTP latency (file_health, 5 runs each) ─────");
const ipcTimes = [];
for (let i = 0; i < 5; i++) {
  const t0 = performance.now();
  await rpc(socketPath, "telemetry/file_health", { file_path: "package.json" });
  ipcTimes.push(performance.now() - t0);
}
const httpTimes = [];
for (let i = 0; i < 5; i++) {
  const { ms } = await http("GET", `/api/file/health?path=${encodeURIComponent("package.json")}`);
  httpTimes.push(ms);
}
const avg = (xs) => round2(xs.reduce((a, b) => a + b, 0) / xs.length);
console.log(`  IPC  avg=${fmtMs(avg(ipcTimes))}  runs=[${ipcTimes.map((t) => round2(t)).join(", ")}]`);
console.log(`  HTTP avg=${fmtMs(avg(httpTimes))}  runs=[${httpTimes.map((t) => round2(t)).join(", ")}]`);

// ── Verdict ────────────────────────────────────────────────────────────────
console.log("\n── VERDICT ──────────────────────────────────────────────");
console.log(`daemon reachable     : ${health.status === 200 ? "YES" : "NO"} (${BASE})`);
console.log(`pipe wired           : ${wt.socketPath ? "YES" : "NO"} (${socketPath})`);
console.log(`JSON-RPC live methods: ${[...liveIpcMethods].join(", ") || "(none)"}`);
console.log(`client E2E           : ${wt.isAvailable && fh && rt?.ok ? "PASS ✓" : "FAIL ✗"}`);
process.exit(wt.isAvailable && fh && rt?.ok ? 0 : 1);
