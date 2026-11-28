/**
 * Send TTL boundary: a message's `expiresAt` must stay representable for any
 * positive integer `ttlMs` accepted by the untrusted send boundaries.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteMailbox } from '../src/sqlite-mailbox.js';

const MAX_EXPIRES_AT_MS = 8_640_000_000_000_000;

let dir: string;
let mb: SqliteMailbox;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-ttl-'));
  mb = new SqliteMailbox(dir);
});

afterEach(async () => {
  await mb.close().catch(() => undefined);
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const send = (ttlMs: number) =>
  mb.send({
    from: 'a',
    to: 'b',
    type: 'info',
    subject: 's',
    body: 'hi',
    ttlMs,
  } as never);

describe('SqliteMailbox send ttlMs', () => {
  it('stamps a future expiresAt for an ordinary ttlMs', async () => {
    const sent = await send(60_000);
    const expiresAtMs = new Date(sent.expiresAt ?? '').getTime();
    expect(Number.isFinite(expiresAtMs)).toBe(true);
    expect(expiresAtMs).toBeGreaterThan(Date.now());
  });

  it('clamps an unrepresentable ttlMs instead of throwing RangeError', async () => {
    // The send boundaries accept any positive integer; a huge one used to
    // throw from `new Date(Date.now() + ttlMs).toISOString()`.
    const sent = await send(Number.MAX_SAFE_INTEGER);
    const expiresAtMs = new Date(sent.expiresAt ?? '').getTime();
    expect(Number.isFinite(expiresAtMs)).toBe(true);
    expect(expiresAtMs).toBe(MAX_EXPIRES_AT_MS);
  });
});
