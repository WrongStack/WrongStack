/**
 * WrongIndex wire contract (WrongIndex WI-102): the adapter against the
 * fixtures WrongIndex's Rust contracts generate. `tests/fixtures/
 * wrongindex-wire.json` is a byte copy of WrongIndex's
 * `contracts/wire/fixtures.json` (regenerated there with
 * `node scripts/contracts/export-wire-fixtures.mjs`; WrongIndex's own test
 * fails when that file is stale). Both directions are checked: the adapter
 * reads what the service sends, and the frames it sends are what the
 * service's types produce.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BASELINE_PROFILE_ID,
  encodeFrame,
  FrameReader,
  MAX_FRAME_BYTES,
  PROTOCOL_MAJOR,
  PROTOCOL_MINOR,
  WrongIndexClient,
  WrongIndexRemoteError,
} from '../src/codebase-index/wrongindex/client.js';
import { OWNER_INFO_FILE, readWrongIndexOwner } from '../src/codebase-index/wrongindex/owner-lock.js';
import { toIndexResult, type WrongIndexJobRecord } from '../src/codebase-index/wrongindex/service.js';

type Json = Record<string, any>;
const wire = JSON.parse(
  fs.readFileSync(new URL('./fixtures/wrongindex-wire.json', import.meta.url), 'utf8'),
) as Json;
const types = wire['types'] as Record<string, Json>;
const errorCodes = (wire['enums']['ErrorCode'] as { code: string; retryable: boolean }[]).map((c) => c.code);
const adapterSources = ['client.ts', 'service.ts', 'owner-lock.ts'].map((f) =>
  fs.readFileSync(new URL(`../src/codebase-index/wrongindex/${f}`, import.meta.url), 'utf8'),
);

/** Same keys, and the same JSON type under each key. */
function sameShape(actual: Json, expected: Json): void {
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  for (const k of Object.keys(expected)) {
    const kind = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);
    expect([k, kind(actual[k])]).toEqual([k, kind(expected[k])]);
  }
}

describe('WrongIndex wire contract', () => {
  it('speaks the same protocol, frame limit and profile', () => {
    expect(PROTOCOL_MAJOR).toBe(wire['protocol']['major']);
    expect(PROTOCOL_MINOR).toBe(wire['protocol']['minor']);
    expect(MAX_FRAME_BYTES).toBe(wire['protocol']['maxFrameBytes']);
    expect(BASELINE_PROFILE_ID).toBe(wire['protocol']['baselineProfileId']);
  });

  it('calls only methods the service has', () => {
    const called = new Set<string>();
    for (const src of adapterSources) {
      for (const m of src.matchAll(/call(?:<[^>]*>)?\(\s*'([a-z]+\.[a-z_]+)'/g)) called.add(m[1]!);
    }
    expect(called.size).toBeGreaterThanOrEqual(8);
    for (const m of called) expect(wire['methods']).toContain(m);
  });

  it('raises and recognizes only the service error codes', () => {
    // client.ts and service.ts talk to the service; owner-lock.ts only sees
    // operating-system error codes (EPERM, ...).
    const used = new Set<string>();
    for (const src of adapterSources.slice(0, 2)) {
      for (const m of src.matchAll(/code(?::| ===?) '([A-Z][A-Z_]+)'/g)) used.add(m[1]!);
    }
    expect(used.size).toBeGreaterThan(0);
    for (const c of used) expect(errorCodes).toContain(c);
    const refused = new WrongIndexRemoteError(types['ResponseError']!['error']);
    expect(refused.code).toBe('QUEUE_SATURATED');
    expect(refused.retryable).toBe(true);
  });

  it('knows every job state the service reports', () => {
    const states: WrongIndexJobRecord['state'][] = ['queued', 'running', 'succeeded', 'failed', 'canceled'];
    expect([...states].sort()).toEqual([...(wire['enums']['JobState'] as string[])].sort());
  });

  it('maps a native job result as the service builds it', () => {
    const r = toIndexResult(types['JobRecordSucceeded']!['result']) as Json;
    const native = types['JobRecordSucceeded']!['result']['native'];
    expect(r['filesIndexed']).toBe(native['filesIndexed']);
    expect(r['symbolsIndexed']).toBe(native['symbolsIndexed']);
    expect(r['changedFiles']).toBe(native['changedFiles']);
    expect(r['durationMs']).toBe(native['durationMs']);
  });

  it('reads the registration, lease and owner record fields it relies on', () => {
    expect(typeof types['RegisterProjectResult']!['project']['projectId']).toBe('string');
    expect(typeof types['SessionLease']!['sessionId']).toBe('string');
    expect(typeof types['SessionLease']!['heartbeatMs']).toBe('number');
    expect(typeof types['JobAdmission']!['job']['jobId']).toBe('string');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wi-wire-owner-'));
    try {
      fs.writeFileSync(path.join(dir, OWNER_INFO_FILE), JSON.stringify(types['OwnerInfo']));
      const owner = readWrongIndexOwner(dir);
      const want = types['OwnerInfo']!;
      expect(owner).toMatchObject({
        owner: want['owner'],
        instanceId: want['instanceId'],
        pid: want['pid'],
        epoch: want['epoch'],
        acquiredAtMs: want['acquiredAtMs'],
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('against a service that answers with the fixtures', () => {
    let server: net.Server | null = null;
    let root: string | null = null;
    afterEach(() => {
      server?.close();
      server = null;
      if (root) fs.rmSync(root, { recursive: true, force: true });
      root = null;
    });

    it('handshakes, sends the request the service expects, and maps its answers', async () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'wi-wire-'));
      const endpoint =
        process.platform === 'win32'
          ? `\\\\.\\pipe\\wi-wire-${process.pid}-${Date.now()}`
          : path.join(root, 'wire.sock');
      const received: Json[] = [];
      server = net.createServer((socket) => {
        const reader = new FrameReader();
        socket.on('data', (chunk: Buffer) => {
          for (const frame of reader.push(chunk) as Json[]) {
            received.push(frame);
            if (received.length === 1) {
              socket.write(encodeFrame(types['AuthResponseOk']));
            } else if (received.length === 2) {
              socket.write(encodeFrame({ ...types['ResponseOk'], requestId: frame['requestId'] }));
            } else {
              socket.write(encodeFrame({ ...types['ResponseError'], requestId: frame['requestId'] }));
            }
          }
        });
      });
      await new Promise<void>((resolve) => server!.listen(endpoint, resolve));
      fs.mkdirSync(path.join(root, 'runtime'));
      fs.writeFileSync(
        path.join(root, 'runtime', 'endpoint.json'),
        JSON.stringify({ ...types['EndpointInfo'], endpoint }),
      );
      fs.writeFileSync(path.join(root, 'runtime', 'token'), 'fixture-token\n');

      const client = await WrongIndexClient.connect({ dataRoot: root, clientName: 'wrongstack' });
      // The hello the service sends is read as sent.
      expect(client.hello).toEqual(types['Hello']);
      // The auth frame has exactly the service's AuthRequest shape.
      sameShape(received[0]!, types['AuthRequest']!);
      expect(received[0]!['token']).toBe('fixture-token');
      expect(received[0]!['supportedProfileIds']).toEqual([BASELINE_PROFILE_ID]);

      // The first request is byte-for-byte the Request the Rust types build.
      const req = types['Request']!;
      const result = await client.call(req['method'], req['projectId'], req['params'], req['idempotencyKey']);
      expect(received[1]).toEqual(req);
      expect(result).toEqual(types['ResponseOk']!['result']);

      // A typed refusal arrives as a WrongIndexRemoteError with its code.
      await expect(client.call('job.get', null, { jobId: 'j_1' })).rejects.toMatchObject({
        code: 'QUEUE_SATURATED',
        retryable: true,
      });
      client.close();
    });
  });
});
