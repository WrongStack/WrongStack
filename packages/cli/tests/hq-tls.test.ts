/**
 * Built-in HQ TLS (`--tls-cert` / `--tls-key`): HQ serves HTTPS and WSS, its
 * startup URLs say so, and the input helper refuses half a configuration.
 *
 * The certificate is minted per run with the `openssl` binary rather than
 * committed: a private key in the tree trips every secret scanner and is the
 * wrong habit to teach. Where `openssl` is absent the server test is skipped;
 * the input validation tests always run.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as https from 'node:https';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveHqTlsInput } from '../src/hq-server/tls-input.js';
import { type HqServerHandle, startHqServer } from '../src/hq-server.js';
import { WebSocket } from '../src/ws-runtime.js';

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const OPENSSL = hasOpenssl();

let dir: string;
let handle: HqServerHandle | null = null;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-tls-'));
});

afterEach(async () => {
  if (handle) {
    await handle.close();
    handle = null;
  }
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
});

async function mintCert(): Promise<{ certPath: string; keyPath: string }> {
  const certPath = path.join(dir, 'cert.pem');
  const keyPath = path.join(dir, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '2',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1,DNS:localhost',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  return { certPath, keyPath };
}

function httpsGet(
  port: number,
  pathname: string,
  ca: Buffer,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', ca },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('resolveHqTlsInput', () => {
  it('is off when nothing is given', async () => {
    expect(await resolveHqTlsInput({}, {})).toEqual({ ok: true });
  });

  it('refuses a certificate without its key, and unreadable or non-PEM files', async () => {
    const half = await resolveHqTlsInput({ 'tls-cert': path.join(dir, 'c.pem') }, {});
    expect(half).toMatchObject({ ok: false, error: expect.stringContaining('both') });
    const missing = await resolveHqTlsInput(
      { 'tls-cert': path.join(dir, 'nope.pem'), 'tls-key': path.join(dir, 'nope.key') },
      {},
    );
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining('Cannot read') });
    const junk = path.join(dir, 'junk.txt');
    await fs.writeFile(junk, 'hello');
    expect(await resolveHqTlsInput({ 'tls-cert': junk, 'tls-key': junk }, {})).toMatchObject({
      ok: false,
      error: expect.stringContaining('PEM certificate'),
    });
  });

  it.skipIf(!OPENSSL)('reads the pair from the environment too', async () => {
    const { certPath, keyPath } = await mintCert();
    const input = await resolveHqTlsInput(
      {},
      { WRONGSTACK_HQ_TLS_CERT: certPath, WRONGSTACK_HQ_TLS_KEY: keyPath },
    );
    expect(input.ok && input.tls !== undefined).toBe(true);
  });
});

describe('HQ over built-in TLS', () => {
  it.skipIf(!OPENSSL)('serves HTTPS and advertises https/wss endpoints', async () => {
    const { certPath, keyPath } = await mintCert();
    const input = await resolveHqTlsInput({ 'tls-cert': certPath, 'tls-key': keyPath }, {});
    if (!input.ok || !input.tls) throw new Error('tls input rejected');
    handle = await startHqServer({
      host: '127.0.0.1',
      port: 0,
      dataDir: path.join(dir, 'hq'),
      tls: input.tls,
    });
    expect(handle.tls).toBe(true);
    expect(handle.firstRunSetup?.clientUrl).toMatch(/^wss:\/\/127\.0\.0\.1:\d+\/ws\/client/);
    expect(handle.firstRunSetup?.clientEnv.WRONGSTACK_HQ_URL).toMatch(/^https:\/\//);
    const res = await httpsGet(handle.port, '/healthz', input.tls.cert);
    expect(res).toMatchObject({ status: 200 });
    expect(JSON.parse(res.body)).toEqual({ status: 'ok' });

    // The client WebSocket upgrades over the same TLS listener.
    const clientUrl = handle.firstRunSetup?.clientUrl;
    if (!clientUrl) throw new Error('no client url');
    const ws = new WebSocket(clientUrl, { ca: input.tls.cert });
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', () => resolve());
        ws.once('error', reject);
      });
    } finally {
      ws.terminate();
    }
  });
});
