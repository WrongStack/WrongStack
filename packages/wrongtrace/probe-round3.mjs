// Round-3 checks: lock conflict behavior, symbol history path-only query,
// and the exact shape of the new atlas summary mode.
const B = "http://localhost:3444";
const cut = (s, n = 260) => (s.length > n ? s.slice(0, n) + "..." : s);
const post = (p, body) => fetch(B + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// 1. Lock conflict: second locker with a DIFFERENT owner on a held path.
await post("/api/guardrail/lock", { path: "__conflict__", reason: "first", owner: "agent-a", ttl_seconds: 60 });
const r2 = await post("/api/guardrail/lock", { path: "__conflict__", reason: "second", owner: "agent-b", ttl_seconds: 60 });
console.log("lock-conflict →", r2.status, cut(await r2.text()));
console.log("locks list →", cut(JSON.stringify(await (await fetch(`${B}/api/guardrail/locks`)).json()), 400));
await post("/api/guardrail/unlock", { path: "__conflict__" });

// 2. Symbol history: path-only (no signature) — does "all symbols in file" work?
const realFile = "D:\\Codebox\\PROJECTS\\WrongTrace\\internal\\core\\atlas.go";
for (const q of [`?path=${encodeURIComponent(realFile)}`, `?path=${encodeURIComponent(realFile)}&signature=`]) {
  const r = await fetch(`${B}/api/symbol/history${q}`);
  const t = await r.text();
  console.log(`symbol/history${q.includes("&") ? " (empty sig)" : " (path-only)"} → ${r.status} ${cut(t)}`);
}

// 3. Atlas summary shape: first package entry keys + totals.
const s = await (await fetch(`${B}/api/atlas?summary=true`)).json();
console.log("summary top-level keys =", Object.keys(s).join(","));
console.log("summary pkg[0] keys =", s.packages?.[0] ? Object.keys(s.packages[0]).join(",") : "none");
console.log("summary pkg[0] =", JSON.stringify(s.packages?.[0]));

// 4. Full atlas: does it still carry files+symbols, and does it have totals?
const f = await fetch(`${B}/api/atlas`);
const fj = await f.json();
console.log("full atlas bytes ≈", (await fetch(`${B}/api/atlas`)).headers.get("content-length"), "| totals =", fj.total_packages, fj.total_files, fj.total_loc, fj.total_nodes);
console.log("full atlas pkg[0] has files[] =", Array.isArray(fj.packages?.[0]?.files));
