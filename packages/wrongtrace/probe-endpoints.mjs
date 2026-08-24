// One-shot probe of every WrongTrace endpoint listed in the integration
// protocol, against the live daemon on localhost:3444. Prints status +
// first 200 chars of body so we can see exactly which endpoints are
// implemented vs which 404.

const ENDPOINTS = [
  ["GET", "/api/health"],
  ["GET", "/api/file/health?path=src/foo.ts"],
  ["GET", "/api/symbol/history?path=src/foo.ts&signature=foo()"],
  ["GET", "/api/metrics/friction?limit=10"],
  ["GET", "/api/atlas"],
  ["GET", "/api/cross-thrash?limit=10"],
  ["GET", "/api/events/recent?limit=5"],
  ["GET", "/api/symbols/history?signature=foo()"],
  ["GET", "/api/files/activity?file_path=src/foo.ts"],
  ["POST", "/api/guardrail/lock"],
  ["POST", "/api/guardrail/unlock"],
  ["POST", "/api/telemetry"],
];

const body200 = (s) => s.length > 200 ? s.slice(0, 200) + "..." : s;
for (const [method, path] of ENDPOINTS) {
  try {
    const init = { method, headers: {} };
    if (method !== "GET") {
      init.headers["Content-Type"] = "application/json";
      init.body = JSON.stringify({ path: "__probe__", reason: "endpoint discovery" });
    }
    const res = await fetch(`http://localhost:3444${path}`, init);
    const text = await res.text();
    console.log(`${method.padEnd(4)} ${path.padEnd(60)} → ${res.status}  ${body200(text)}`);
  } catch (err) {
    console.log(`${method.padEnd(4)} ${path.padEnd(60)} → ERR  ${err.message}`);
  }
}
