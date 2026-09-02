/**
 * Discovers whether the external WrongTrace AI Observability daemon is
 * reachable, and if so, where to talk to it.
 *
 * Discovery protocol (per the integration spec):
 *   1. HTTP probe of `${baseUrl}/api/health` with a tight timeout.
 *   2. If the daemon replies 2xx, read `socket_path` from the body for the
 *      IPC path. If absent, fall back to platform-default locations.
 *   3. If MCP tools are registered globally (e.g. via `wrongtrace mcp`),
 *      MCP transport is preferred over HTTP/IPC for actual calls.
 *
 * The whole routine never throws — it returns a `DiscoveryResult` whose
 * `available` flag tells the caller to either bind the full client or
 * install a typed no-op shim. That makes it safe to invoke from the hot
 * path of boot.
 */

import { platform } from 'node:os';
import { join } from 'node:path';

import type { WrongTraceHealth } from './types.js';

export interface DiscoveryOptions {
  /** Override the base URL. Default: process.env.WRONGTRACE_URL ?? "http://localhost:3444". */
  baseUrl?: string;
  /** Probe timeout in ms. Default: 1000. */
  timeoutMs?: number;
  /**
   * Inject a `fetch`-compatible implementation. Tests use this to stub the
   * probe without monkey-patching globals.
   */
  fetchImpl?: typeof fetch;
}

export interface DiscoveryResult {
  available: boolean;
  baseUrl?: string;
  socketPath?: string;
  version?: string;
}

/** Default IPC paths per platform — only consulted when `/api/health` did not return `socket_path`. */
export function defaultSocketPath(
  home = process.env['HOME'] ?? process.env['USERPROFILE'] ?? '',
): string {
  if (platform() === 'win32') return '\\\\.\\pipe\\wrongtrace';
  if (home) return join(home, '.wrongtrace', 'ipc.sock');
  return '/tmp/wrongtrace.sock';
}

export async function discover(opts: DiscoveryOptions = {}): Promise<DiscoveryResult> {
  const baseUrl = opts.baseUrl ?? process.env['WRONGTRACE_URL'] ?? 'http://localhost:3444';
  const timeoutMs = opts.timeoutMs ?? 1000;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  if (typeof fetchImpl !== 'function') {
    return { available: false };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${baseUrl}/api/health`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { available: false, baseUrl };
    const body = (await res.json().catch(() => ({}))) as WrongTraceHealth;
    // Accept either contract the daemon might speak:
    //   * { ok: true }                    (older / strict boolean schema)
    //   * { status: "ok" }                (current WrongProxy-style schema)
    if (body?.ok !== true && body?.status !== 'ok') return { available: false, baseUrl };
    const result: DiscoveryResult = { available: true, baseUrl };
    if (typeof body.socket_path === 'string') result.socketPath = body.socket_path;
    else result.socketPath = defaultSocketPath();
    if (typeof body.version === 'string') result.version = body.version;
    return result;
  } catch {
    return { available: false, baseUrl };
  } finally {
    clearTimeout(timer);
  }
}
