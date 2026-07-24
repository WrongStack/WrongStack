// End-to-end local HQ auto-discovery: a client publisher created BEFORE any
// `wstack --hq` exists stays dormant, then attaches by itself — with the
// client token the HQ minted on ITS first run — as soon as the server starts
// and writes the runtime marker. This is the exact user scenario: every
// WrongStack client on the machine finds a later-started HQ automatically.

import { readHqAuthFile } from '@wrongstack/core/hq';
import type { HqPublisher } from '@wrongstack/core/hq';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCliHqPublisher } from '../src/hq-publisher.js';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';

function getPort(): number {
  return 37_000 + Math.floor(Math.random() * 3_000);
}

let dataDir = '';
let savedDataDirEnv: string | undefined;
let handle: HqServerHandle | undefined;
let publisher: HqPublisher | undefined;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-hq-discover-'));
  savedDataDirEnv = process.env['WRONGSTACK_HQ_DATA_DIR'];
  process.env['WRONGSTACK_HQ_DATA_DIR'] = dataDir;
});

afterEach(async () => {
  publisher?.close();
  publisher = undefined;
  if (handle) {
    await handle.close();
    handle = undefined;
  }
  if (savedDataDirEnv === undefined) delete process.env['WRONGSTACK_HQ_DATA_DIR'];
  else process.env['WRONGSTACK_HQ_DATA_DIR'] = savedDataDirEnv;
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('HQ local auto-discovery (client first, --hq later)', () => {
  it('a dormant client attaches to an HQ started after it, using the first-run token', async () => {
    // 1. Client boots first — no HQ has EVER run: no runtime.json, no auth.json.
    publisher = createCliHqPublisher({
      clientKind: 'cli',
      projectRoot: dataDir,
      projectName: 'discover-me',
      discoveryPollMs: 200,
    });
    expect(publisher, 'discovery mode must create a publisher with zero config').toBeDefined();
    publisher?.connect();
    // Telemetry published while dormant queues up for the eventual flush.
    publisher?.publishEvent({ type: 'tool.executed', payload: { tool: 'read', ok: true } });

    // Still no HQ — nothing to attach to.
    await new Promise((r) => setTimeout(r, 500));

    // 2. `wstack --hq` starts NOW: first run mints auth tokens + runtime.json.
    handle = await startHqServer({ port: getPort(), dataDir });

    // 3. Within a few discovery polls the client must appear in the snapshot.
    const auth = await readHqAuthFile(dataDir);
    const browserToken = auth.browserTokens?.[0]?.token;
    expect(browserToken, 'first run should mint a browser token').toBeTruthy();

    await expect
      .poll(
        async () => {
          const res = await fetch(
            `http://127.0.0.1:${handle?.port}/api/snapshot?token=${browserToken}`,
          ).catch(() => undefined);
          if (!res?.ok) return undefined;
          const snapshot = (await res.json()) as {
            clients?: Array<{ kind?: string; connected?: boolean }>;
            projects?: Array<{ projectName?: string }>;
          };
          const connected = snapshot.clients?.find((c) => c.kind === 'cli' && c.connected);
          const project = snapshot.projects?.find((p) => p.projectName === 'discover-me');
          return connected !== undefined && project !== undefined ? 'attached' : undefined;
        },
        { timeout: 15_000, interval: 300 },
      )
      .toBe('attached');
  }, 60_000);
});
