/**
 * WS-044 — HQ browser tokens authenticate against a stored verifier, and a
 * pre-migration file keeps working.
 *
 * `auth.json` held browser bearer tokens in cleartext directly beside a
 * correctly scrypt-hashed password, so a copy of the file — a home-directory
 * backup, a synced folder, a support bundle — was a working credential for a
 * token carrying `control.enqueue`, which drives agents.
 *
 * The projection built by `createHqAuthState` is the thing under test: it must
 * key on `hqTokenKey`, so a hashed record and a legacy cleartext one land on
 * the same key and both authenticate. Otherwise the migration would silently
 * lock operators out of their own HQ.
 */
import type * as http from 'node:http';
import { HQ_AUTH_FILE_VERSION, type HqAuthFile, hqTokenVerifier } from '@wrongstack/core/hq';
import { describe, expect, it } from 'vitest';
import { authenticateBrowserRequest } from '../src/hq-server/auth.js';
import { createHqAuthState } from '../src/hq-server/auth-state.js';

const SECRET = 'b'.repeat(64);

function authFileWith(browserTokens: HqAuthFile['browserTokens']): HqAuthFile {
  return {
    version: HQ_AUTH_FILE_VERSION,
    updatedAt: new Date().toISOString(),
    browserTokens,
  } as HqAuthFile;
}
function req(authorization: string): http.IncomingMessage {
  return {
    headers: { host: '127.0.0.1:3499', authorization },
  } as unknown as http.IncomingMessage;
}

function authenticate(file: HqAuthFile, presented: string) {
  const { mutableAuth } = createHqAuthState(file, process.cwd());
  return authenticateBrowserRequest(
    req(`Bearer ${presented}`),
    new URL('/api/state', 'http://placeholder.invalid'),
    mutableAuth,
    new Map(),
  );
}

describe('HQ browser token verifiers', () => {
  const created = new Date().toISOString();

  it('authenticates against a stored verifier with no secret on disk', () => {
    const file = authFileWith([
      { id: 'b1', token: '', verifier: hqTokenVerifier(SECRET), createdAt: created },
    ]);
    const auth = authenticate(file, SECRET);
    expect(auth?.kind).toBe('token');
  });

  it('still authenticates a legacy cleartext record during migration', () => {
    const file = authFileWith([{ id: 'b1', token: SECRET, createdAt: created }]);
    expect(authenticate(file, SECRET)?.kind).toBe('token');
  });

  it('rejects a wrong secret against a verifier record', () => {
    const file = authFileWith([
      { id: 'b1', token: '', verifier: hqTokenVerifier(SECRET), createdAt: created },
    ]);
    expect(authenticate(file, 'c'.repeat(64))).toBeUndefined();
  });

  it('rejects the verifier itself presented as if it were the secret', () => {
    // The whole point of hashing: what is on disk must not be replayable.
    const verifier = hqTokenVerifier(SECRET);
    const file = authFileWith([{ id: 'b1', token: '', verifier, createdAt: created }]);
    expect(authenticate(file, verifier)).toBeUndefined();
  });

  it('does not admit a record that carries neither a secret nor a verifier', () => {
    const file = authFileWith([{ id: 'b1', token: '', createdAt: created }]);
    expect(authenticate(file, '')).toBeUndefined();
    expect(authenticate(file, SECRET)).toBeUndefined();
  });

  it('carries capabilities through from a hashed record', () => {
    const file = authFileWith([
      {
        id: 'b1',
        token: '',
        verifier: hqTokenVerifier(SECRET),
        createdAt: created,
        capabilities: ['control.enqueue'],
      },
    ]);
    const auth = authenticate(file, SECRET);
    expect(auth?.kind).toBe('token');
    expect(auth && 'capabilities' in auth ? auth.capabilities : undefined).toEqual([
      'control.enqueue',
    ]);
  });

  it('still refuses an expired hashed record', () => {
    const file = authFileWith([
      {
        id: 'b1',
        token: '',
        verifier: hqTokenVerifier(SECRET),
        createdAt: created,
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
      },
    ]);
    expect(authenticate(file, SECRET)).toBeUndefined();
  });
});
