// Live verification of the agent-helpers against the running daemon.
import { createWrongTraceClient } from "./dist/client.js";
import { getCrossAgentRisk, summarizeFriction, digestAtlas, getRecentActivity } from "./dist/agent-helpers.js";

const c = await createWrongTraceClient({ baseUrl: "http://localhost:3444", timeoutMs: 1500 });
console.log("client.isAvailable =", c.isAvailable, "| socketPath =", c.socketPath);

const risk = await getCrossAgentRisk(c, "packages/wrongtrace/src/agent-helpers.ts");
console.log("\ngetCrossAgentRisk(agent-helpers.ts):");
console.log("  risk =", risk.risk, "| band =", risk.band);
for (const r of risk.reasons) console.log("  -", r);

const risk2 = await getCrossAgentRisk(c, "packages/tui/tests/drag-selection-copy.test.tsx");
console.log("\ngetCrossAgentRisk(tui test file seen in friction):");
console.log("  risk =", risk2.risk, "| band =", risk2.band, "|", risk2.reasons.join("; "));

const f = await c.getFrictionMatrix(50);
const fs = summarizeFriction(Array.isArray(f) ? { edges: f, total_collisions: f.length } : f);
console.log("\nsummarizeFriction(live):");
console.log("  totalCollisions =", fs.totalCollisions);
console.log("  topPair =", fs.topPair);
console.log("  prose =", fs.prose);

const a = await c.getAtlas();
const d = digestAtlas(a);
console.log("\ndigestAtlas(live):");
console.log(" ", d?.prose);

const act = await getRecentActivity(c, "D:\\Codebox\\PROJECTS\\WrongTrace\\internal\\server\\server_test.go");
console.log("\ngetRecentActivity(WrongTrace server_test.go, absolute path):");
console.log("  entries =", act.length, act.slice(0, 2).map((e) => `${e.actor}@${e.at}`).join(", "));

// ── NEW daemon endpoints (round-2 + round-3 updates) ─────────────
const events = await c.getRecentEvents({ limit: 3, repo: "WrongTrace" });
console.log("\ngetRecentEvents({limit:3, repo:'WrongTrace'}):");
console.log("  count =", events.length);
if (events[0]) console.log("  [0]", events[0].author_model, events[0].action, events[0].node_signature);

const sinceEvents = await c.getRecentEvents({ limit: 3, since: "2026-08-24T18:00:00Z" });
console.log("getRecentEvents({since:18:00Z}):", sinceEvents.length, "events");

const locks = await c.listLocks();
console.log("\nlistLocks():", JSON.stringify(locks));

const lockRes = await c.lockFile("__adapter_probe__", "adapter TTL verification", {
  owner: "wrongstack-adapter",
  ownerRunId: "ws-verify-3",
  ttlSeconds: 60,
});
console.log("\nlockFile(with owner+TTL):", JSON.stringify(lockRes));

// lock conflict: second lock with different owner must yield 409-shaped result
const conflict = await c.lockFile("__adapter_probe__", "conflicting claim", {
  owner: "other-agent",
  ttlSeconds: 30,
});
console.log("lockFile(conflict):", JSON.stringify(conflict));

const h = await c.getFileHealth("__adapter_probe__");
console.log("file/health(locked) → is_locked =", h?.is_locked, "| owner =", h?.lock_owner, "| expires =", h?.lock_expires_at);

console.log("unlockFile:", JSON.stringify(await c.unlockFile("__adapter_probe__")));

const tel = await c.reportTelemetry({
  run_id: "ws-verify-3", task_id: "schema-verify", agent_name: "WrongStack-Adapter",
  model_name: "probe", provider: "internal",
  prompt_tokens: 10, completion_tokens: 2, cost_usd: 0, intent: "live schema verification r3",
});
console.log("\nreportTelemetry(live):", JSON.stringify(tel));

// round-3: symbol lineage — path-only returns ALL symbol events for the file
const lineage = await c.getSymbolLineage("D:\\Codebox\\PROJECTS\\WrongTrace\\internal\\core\\atlas.go");
console.log("\ngetSymbolLineage(path-only):", lineage.length, "events");
if (lineage[0]) console.log("  [0]", lineage[0].author_model, lineage[0].action, lineage[0].node_signature);

// round-3: atlas summary mode + workspace filter
const atlasSummary = await c.getAtlas({ summary: true });
console.log("\ngetAtlas({summary:true}) totals =", atlasSummary?.total_packages, "pkgs /", atlasSummary?.total_files, "files /", atlasSummary?.total_loc, "loc");
if (atlasSummary?.packages?.[0]) console.log("  pkg[0]", JSON.stringify(atlasSummary.packages[0]));

const atlasFiltered = await c.getAtlas({ workspace: "internal" });
console.log("getAtlas({workspace:'internal'}) pkgs =", atlasFiltered?.packages?.length, "| has files[] =", Array.isArray(atlasFiltered?.packages?.[0]?.files));
