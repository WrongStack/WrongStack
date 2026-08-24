// Deep probe: verify the NEW endpoint schemas + test filter params that
// were previously undocumented/missing. Focused follow-up to probe-endpoints.mjs.
const B = "http://localhost:3444";
const cut = (s, n = 300) => (s.length > n ? s.slice(0, n) + "..." : s);
async function j(label, path, init) {
  try {
    const r = await fetch(B + path, init);
    console.log(`${label} → ${r.status} ${cut(await r.text())}`);
  } catch (e) {
    console.log(`${label} → ERR ${e.message}`);
  }
}

// 1. events/recent full shape (first event, pretty)
const ev = await fetch(`${B}/api/events/recent?limit=2`).then((r) => r.json());
console.log("events/recent[0] keys =", Array.isArray(ev) ? Object.keys(ev[0] ?? {}).join(",") : JSON.stringify(Object.keys(ev)));

// 2. events/recent with since param
await j("events/recent?since", `/api/events/recent?limit=3&since=2026-08-24T18:00:00Z`);

// 3. events/recent with repo filter
await j("events/recent?repo", `/api/events/recent?limit=3&repo=WrongTrace`);

// 4. symbol history with daemon-format signature (from a known live event)
const knownSig = ev[0]?.node_signature ?? "";
console.log("known node_signature =", knownSig);
await j("symbol/history(fmt)", `/api/symbol/history?signature=${encodeURIComponent(knownSig)}`);
await j("symbols/history(fmt)", `/api/symbols/history?signature=${encodeURIComponent(knownSig)}`);

// 5. atlas workspace filter + summary mode
await j("atlas?workspace", `/api/atlas?workspace=internal`);
await j("atlas?summary", `/api/atlas?summary=true`);

// 6. file health with a REAL file from the events feed
const realPath = ev[0]?.file_path ?? "";
console.log("real file_path from events =", realPath);
if (realPath) {
  await j("file/health(real)", `/api/file/health?path=${encodeURIComponent(realPath)}`);
  await j("files/activity(real)", `/api/files/activity?file_path=${encodeURIComponent(realPath)}`);
  await j("files/activity(path=)", `/api/files/activity?path=${encodeURIComponent(realPath)}`);
  // symbol history for the real file
  await j("symbol/history(real+fmt)", `/api/symbol/history?path=${encodeURIComponent(realPath)}&signature=${encodeURIComponent(knownSig)}`);
}

// 7. guardrail locks listing
await j("guardrail/locks", `/api/guardrail/locks`);

// 8. telemetry with full body (verify accepted fields)
await j("telemetry(full)", `/api/telemetry`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    run_id: "ws-verify-1", task_id: "verify", agent_name: "WrongStack",
    model_name: "test-model", provider: "anthropic",
    prompt_tokens: 100, completion_tokens: 10, cost_usd: 0.001,
    intent: "schema verification probe",
  }),
});

// 9. lock round-trip with owner (verify TTL echo)
await j("lock(full)", `/api/guardrail/lock`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ path: "__probe2__", reason: "ttl check", owner: "ws-agent", owner_run_id: "ws-verify-1", ttl_seconds: 60 }),
});
await j("file/health(locked probe)", `/api/file/health?path=__probe2__`);
await j("unlock(full)", `/api/guardrail/unlock`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ path: "__probe2__" }),
});
