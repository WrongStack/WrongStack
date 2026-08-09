/**
 * WS-078 — the exposure preflight must judge on LIVE tokens.
 *
 * `prepareHqServerStart` counted `authFile.browserTokens.length` straight from
 * disk, while the running router builds its usable set through `liveTokens()`,
 * which drops expired entries. The two disagreed in exactly one direction: an
 * auth file whose tokens had all expired satisfied the exposure check, so HQ
 * bound the wildcard host, and then handed the router an empty token set — which
 * the router read as "no auth configured" and skipped the /api/* gate for.
 *
 * The trigger is token TTL rotation (`--hq-token-ttl`), i.e. the finding only
 * fires against operators who chose the more careful configuration.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HqAuthFile } from '@wrongstack/core/hq';
import {
  HQ_AUTH_FILE_VERSION,
  HqInsecureExposureError,
  writeHqAuthFile,
} from '@wrongstack/core/hq';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareHqServerStart } from '../src/hq-server/preflight.js';

let dataDir: string;

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-preflight-'));
});

afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

function isoIn(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function tokenExpiring(id: string, value: string, offsetMs: number) {
  return {
    id,
    token: value,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: isoIn(offsetMs),
  };
}

async function seed(overrides: Partial<HqAuthFile>): Promise<void> {
  const file: HqAuthFile = {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens: [],
    clientTokens: [],
    ...overrides,
  };
  await writeHqAuthFile(dataDir, file);
}

const defaults = { host: '0.0.0.0', port: 4319 };

describe('prepareHqServerStart — expired tokens are not credentials', () => {
  it('refuses a wildcard bind when every browser token has expired', async () => {
    await seed({ browserTokens: [tokenExpiring('b1', 'expired-secret', -60_000)] });

    // Before WS-078 this resolved: the raw array was non-empty, so the exposure
    // check saw "has browser tokens" and allowed 0.0.0.0 — with the router then
    // running gate-free because its live set was empty.
    await expect(
      prepareHqServerStart({ dataDir, host: '0.0.0.0' }, defaults),
    ).rejects.toBeInstanceOf(HqInsecureExposureError);
  });

  it('names expiry as the cause instead of reporting "no tokens"', async () => {
    await seed({
      browserTokens: [
        tokenExpiring('b1', 'expired-one', -60_000),
        tokenExpiring('b2', 'expired-two', -120_000),
      ],
    });

    await expect(prepareHqServerStart({ dataDir, host: '0.0.0.0' }, defaults)).rejects.toThrow(
      /expired/i,
    );
  });

  it('allows a wildcard bind when at least one browser token is still live', async () => {
    await seed({
      browserTokens: [
        tokenExpiring('b1', 'expired-secret', -60_000),
        tokenExpiring('b2', 'live-secret', 60 * 60_000),
      ],
    });

    const result = await prepareHqServerStart({ dataDir, host: '0.0.0.0' }, defaults);
    expect(result.host).toBe('0.0.0.0');
  });

  it('rejects requireBrowserAuth when the only token has expired', async () => {
    await seed({ browserTokens: [tokenExpiring('b1', 'expired-secret', -1_000)] });

    await expect(
      prepareHqServerStart({ dataDir, host: '127.0.0.1', requireBrowserAuth: true }, defaults),
    ).rejects.toThrow(/expired/i);
  });

  it('still allows a loopback bind with no credential at all (local open mode)', async () => {
    await seed({});
    const result = await prepareHqServerStart({ dataDir, host: '127.0.0.1' }, defaults);
    expect(result.host).toBe('127.0.0.1');
  });
});
