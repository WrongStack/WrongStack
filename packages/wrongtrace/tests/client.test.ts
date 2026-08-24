import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createWrongTraceClient } from "../client.js";
import { discover, defaultSocketPath } from "../discovery.js";

/**
 * Minimal fetch stub. The cast through `unknown` is required because the
 * `RequestInfo` global only exists under DOM lib types — this test runs
 * in Node and just needs a structurally-compatible function.
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

describe("discover()", () => {
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch as typeof fetch;
    // vi.useRealTimers is safe to call even when fake timers were never installed.
  });

  it("returns available:false when the daemon is unreachable", async () => {
    const result = await discover({
      baseUrl: "http://nowhere.local",
      fetchImpl: makeFetch(() => {
        throw new Error("ECONNREFUSED");
      }),
      timeoutMs: 50,
    });
    expect(result.available).toBe(false);
    expect(result.baseUrl).toBe("http://nowhere.local");
  });

  it("returns available:true with socket_path when /api/health replies ok", async () => {
    globalThis.fetch = makeFetch(() => jsonResponse({ ok: true, version: "0.3.0", socket_path: "/tmp/wt.sock" }));
    const result = await discover({ baseUrl: "http://localhost:3444" });
    expect(result.available).toBe(true);
    expect(result.version).toBe("0.3.0");
    expect(result.socketPath).toBe("/tmp/wt.sock");
  });

  it("falls back to a platform-default socket_path when health omits one", async () => {
    globalThis.fetch = makeFetch(() => jsonResponse({ ok: true }));
    const result = await discover({ baseUrl: "http://localhost:3444" });
    expect(result.available).toBe(true);
    expect(typeof result.socketPath).toBe("string");
    expect(result.socketPath!.length).toBeGreaterThan(0);
  });

  it("rejects non-2xx responses with available:false", async () => {
    globalThis.fetch = makeFetch(() => jsonResponse({ ok: false }, 503));
    const result = await discover({ baseUrl: "http://localhost:3444" });
    expect(result.available).toBe(false);
  });

  it("aborts the probe within the configured timeout", async () => {
    let aborted = false;
    globalThis.fetch = makeFetch((_url, init) => {
      // Abort-aware stub: matches the contract of undici / Web fetch so the
      // adapter's `AbortSignal.timeout()` actually unblocks the await chain.
      return new Promise<Response>((_resolve, reject) => {
        if (init?.signal?.aborted) {
          aborted = true;
          reject(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    });
    const t0 = Date.now();
    const result = await discover({ baseUrl: "http://localhost:3444", timeoutMs: 100 });
    const elapsed = Date.now() - t0;
    expect(result.available).toBe(false);
    expect(aborted).toBe(true);
    expect(elapsed).toBeLessThan(500);
  });

  it("defaultSocketPath returns a non-empty string on this platform", () => {
    const p = defaultSocketPath();
    expect(typeof p).toBe("string");
    expect(p.length).toBeGreaterThan(0);
  });
});

describe("createWrongTraceClient()", () => {
  let originalFetch: typeof fetch | undefined;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch as typeof fetch;
  });

  it("reports isAvailable:false when discovery fails — every method is a no-op", async () => {
    globalThis.fetch = makeFetch(() => {
      throw new Error("ECONNREFUSED");
    });
    const wt = await createWrongTraceClient({ baseUrl: "http://nowhere.local", timeoutMs: 50 });
    expect(wt.isAvailable).toBe(false);

    expect(await wt.getHealth()).toBeNull();
    expect(await wt.getFileHealth("src/foo.ts")).toBeNull();
    expect(await wt.getSymbolLineage("src/foo.ts", "foo()")).toBeNull();
    expect(await wt.getFrictionMatrix()).toEqual([]);
    expect(await wt.getAtlas()).toBeNull();
    expect(await wt.lockFile("src/foo.ts", "test")).toBeNull();
    expect(await wt.unlockFile("src/foo.ts")).toBeNull();
    expect(await wt.reportTelemetry({
      run_id: "r", agent_name: "a", model_name: "m", provider: "anthropic",
      prompt_tokens: 0, completion_tokens: 0, cost_usd: 0, intent: "x",
    })).toBeNull();
  });

  it("lockFile POSTs to /api/guardrail/lock with path + reason when daemon is up", async () => {
    const seen: Array<{ url: string; method: string; body?: unknown }> = [];
    globalThis.fetch = makeFetch(async (url, init) => {
      const u = new URL(url);
      if (u.pathname === "/api/health") return jsonResponse({ ok: true });
      const parsed = init?.body ? JSON.parse(String(init.body)) : undefined;
      seen.push({ url, method: init?.method ?? "GET", body: parsed });
      return jsonResponse({ ok: true, path: u.searchParams.get("path") ?? "" });
    });

    const wt = await createWrongTraceClient({ baseUrl: "http://localhost:3444" });
    expect(wt.isAvailable).toBe(true);
    const res = await wt.lockFile("src/auth/middleware.ts", "refactor in progress");
    expect(res?.ok).toBe(true);
    const lockCall = seen.find((c) => c.url.endsWith("/api/guardrail/lock"));
    expect(lockCall).toBeDefined();
    expect(lockCall?.method).toBe("POST");
    expect(lockCall?.body).toEqual({ path: "src/auth/middleware.ts", reason: "refactor in progress" });
  });

  it("routes getFileHealth through MCP when the tool is wired", async () => {
    let httpCalls = 0;
    globalThis.fetch = makeFetch(async (url) => {
      httpCalls++;
      const u = new URL(url);
      if (u.pathname === "/api/health") return jsonResponse({ ok: true });
      return jsonResponse({ path: "", health_score: 0, is_fragile: false, recent_thrashing_count: 0, is_locked: false });
    });
    const wt = await createWrongTraceClient({
      baseUrl: "http://localhost:3444",
      mcpTools: {
        get_file_health_score: async (args) => ({
          path: args.path,
          health_score: 95,
          is_fragile: false,
          recent_thrashing_count: 0,
          is_locked: false,
        }),
      },
    });
    const health = await wt.getFileHealth("src/foo.ts");
    expect(health?.health_score).toBe(95);
    expect(httpCalls).toBe(1); // only /api/health hit HTTP
  });

  it("falls back to HTTP when MCP tool is wired but throws", async () => {
    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/health") return jsonResponse({ ok: true });
      if (u.pathname === "/api/file/health") {
        return jsonResponse({ path: "src/foo.ts", health_score: 30, is_fragile: true, recent_thrashing_count: 7, is_locked: false });
      }
      return jsonResponse({});
    });
    const wt = await createWrongTraceClient({
      baseUrl: "http://localhost:3444",
      mcpTools: { get_file_health_score: async () => { throw new Error("MCP down"); } },
    });
    const health = await wt.getFileHealth("src/foo.ts");
    expect(health?.is_fragile).toBe(true);
    expect(health?.health_score).toBe(30);
  });

  it("getFrictionMatrix returns [] when the daemon replies with an error", async () => {
    globalThis.fetch = makeFetch(async (url) => {
      const u = new URL(url);
      if (u.pathname === "/api/health") return jsonResponse({ ok: true });
      return new Response("boom", { status: 500 });
    });
    const wt = await createWrongTraceClient({ baseUrl: "http://localhost:3444" });
    expect(await wt.getFrictionMatrix()).toEqual([]);
  });
});
