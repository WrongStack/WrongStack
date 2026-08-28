/**
 * HQ server — runtime marker and startup info printing.
 *
 * Writes/clears the `<dataDir>/runtime.json` marker and prints the
 * operator-facing startup banner with LAN endpoints.
 *
 * @module hq-server/startup
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { writeHqRuntimeFile } from '@wrongstack/core/hq';
import { terminalLink, terminalText } from '../terminal-format.js';
import * as HqServerUtils from './utils.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface HqRuntimeMarker {
  url?: string;
  pid?: number;
  updatedAt?: string;
}

// ── Runtime marker ─────────────────────────────────────────────────────────

export const hqRuntimeMarkerPath = HqServerUtils.hqRuntimeMarkerPath;

/**
 * Write `<dataDir>/runtime.json` so auto-discovering clients on this machine
 * can find this HQ instance. Overwrites any previous marker.
 */
export async function writeHqRuntimeMarker(dataDir: string, url: string): Promise<void> {
  // Delegates to core. This used to be a hand-rolled `fs.writeFile` with
  // `mode: 0o600`, which on Windows is a no-op beyond the read-only bit — and
  // this file carries the local HQ client token. Core's writer was hardened
  // for exactly that (WS-045: `restrictFilePermissions` after the write), but
  // the hardening was never back-ported to the only site that actually writes
  // the marker, so the fix protected a path nothing used.
  await fs.mkdir(dataDir, { recursive: true });
  await writeHqRuntimeFile(dataDir, { url, pid: process.pid });
}

/**
 * Remove `<dataDir>/runtime.json` only when it belongs to this process
 * (same URL and PID). Best-effort — never throws.
 */
export async function clearHqRuntimeMarker(dataDir: string, url: string): Promise<void> {
  const file = hqRuntimeMarkerPath(dataDir);
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as HqRuntimeMarker;
    if (parsed.url === url && parsed.pid === process.pid) {
      await fs.rm(file, { force: true });
    }
  } catch {
    // Best-effort cleanup only.
  }
}

// ── Startup info ───────────────────────────────────────────────────────────

interface HqStartupInfoHandle {
  host: string;
  port: number;
  firstRunSetup?: {
    dataDir: string;
    browserUrl: string;
    clientUrl: string;
    clientEnv: {
      WRONGSTACK_HQ_URL: string;
      WRONGSTACK_HQ_TOKEN?: string;
    };
    createdAuth: boolean;
    browserTokenMode: boolean;
    passwordMode: boolean;
  };
}

/**
 * Print the operator-facing startup banner. When firstRunSetup is present,
 * print richer first-run instructions with credentials; otherwise a minimal
 * endpoint listing.
 */
export function writeHqStartupInfo(
  write: (line: string) => void,
  handle: HqStartupInfoHandle,
): void {
  const startup = handle.firstRunSetup;
  const browserUrl = HqServerUtils.buildHttpUrl(handle.host, handle.port);
  const clientUrl = HqServerUtils.buildClientWsUrl(handle.host, handle.port);
  write(
    `${terminalText('WrongStack HQ', 'magenta')} ${terminalText('listening on', 'green')} ${terminalLink(browserUrl)}\n`,
  );
  if (!startup) {
    write(`${terminalText('Browser endpoint:', 'blue')} ${terminalLink(browserUrl)}\n`);
    write(`${terminalText('Client endpoint:', 'blue')}  ${terminalLink(clientUrl)}\n`);
    writeHqLanEndpoints(write, handle, undefined);
    return;
  }

  write(`${terminalText('Browser endpoint:', 'blue')} ${terminalLink(startup.browserUrl)}\n`);
  write(`${terminalText('Client endpoint:', 'blue')}  ${terminalLink(startup.clientUrl)}\n`);
  if (startup.createdAuth) {
    write(`\nFirst-run HQ auth created in ${startup.dataDir}\n`);
  } else {
    write(`\nHQ auth loaded from ${startup.dataDir}\n`);
  }
  write('Start clients with:\n');
  write(`  WRONGSTACK_HQ_URL=${startup.clientEnv.WRONGSTACK_HQ_URL}\n`);
  if (startup.clientEnv.WRONGSTACK_HQ_TOKEN) {
    write(`  WRONGSTACK_HQ_TOKEN=${startup.clientEnv.WRONGSTACK_HQ_TOKEN}\n`);
    write(`Credentials are stored in ${path.join(startup.dataDir, 'auth.json')}\n`);
  }
  writeHqLanEndpoints(write, handle, undefined);
}

/** When bound to all interfaces, print LAN URLs so other machines can reach HQ. */
function writeHqLanEndpoints(
  write: (line: string) => void,
  handle: HqStartupInfoHandle,
  browserToken: string | undefined,
): void {
  if (handle.host !== '0.0.0.0' && handle.host !== '::') return;
  const ips = HqServerUtils.lanIPv4Addresses();
  if (ips.length === 0) return;
  write(
    `\n${terminalText('Reachable from other machines on your network:', 'blue', { bold: true })}\n`,
  );
  for (const ip of ips) {
    const url = HqServerUtils.buildHttpUrl(ip, handle.port, browserToken);
    write(`  ${terminalLink(url)}\n`);
  }
  const firstIp = ips[0];
  if (firstIp === undefined) return;
  const clientUrl = HqServerUtils.buildHttpUrl(firstIp, handle.port);
  write(
    `  ${terminalText('On another machine, set', 'muted')} WRONGSTACK_HQ_URL=${terminalLink(clientUrl)}\n`,
  );
}
