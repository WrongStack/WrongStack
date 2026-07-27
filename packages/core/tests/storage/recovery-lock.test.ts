import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RecoveryLock } from '../../src/storage/recovery-lock.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';

async function mktmp(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-lock-'));
}

describe('RecoveryLock', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mktmp();
  });
  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  describe('write + clear', () => {
    it('writes the lockfile and clear removes it', async () => {
      const lock = new RecoveryLock({ dir, pid: 1234, hostname: 'h', isPidAlive: () => false });
      await lock.write('sess-1');
      const raw = await fsp.readFile(path.join(dir, 'active.json'), 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed).toMatchObject({
        v: 1,
        sessionId: 'sess-1',
        pid: 1234,
        hostname: 'h',
      });
      expect(typeof parsed.startedAt).toBe('string');

      await lock.clear();
      await expect(fsp.access(path.join(dir, 'active.json'))).rejects.toThrow();
    });

    it('clear is idempotent when the file is already gone', async () => {
      const lock = new RecoveryLock({ dir, pid: 1, hostname: 'h', isPidAlive: () => false });
      await expect(lock.clear()).resolves.toBeUndefined();
    });

    it('refuses to overwrite an existing lockfile (race guard)', async () => {
      const lock = new RecoveryLock({ dir, pid: 1, hostname: 'h', isPidAlive: () => false });
      await lock.write('first');
      // O_EXCL: a second write without clearing must throw rather than
      // silently clobbering another process's recovery record.
      await expect(lock.write('second')).rejects.toThrow(/already held/);
      const parsed = JSON.parse(await fsp.readFile(path.join(dir, 'active.json'), 'utf8'));
      expect(parsed.sessionId).toBe('first');
      // After an explicit clear() the lock can be re-acquired.
      await lock.clear();
      await lock.write('second');
      const reparsed = JSON.parse(await fsp.readFile(path.join(dir, 'active.json'), 'utf8'));
      expect(reparsed.sessionId).toBe('second');
    });
  });

  describe('checkAbandoned', () => {
    it('returns null when no lockfile exists', async () => {
      const lock = new RecoveryLock({ dir, isPidAlive: () => false });
      expect(await lock.checkAbandoned()).toBeNull();
    });

    it('returns null when the PID is still alive on the same host', async () => {
      const lock = new RecoveryLock({
        dir,
        pid: 999,
        hostname: 'samehost',
        isPidAlive: () => true,
      });
      await lock.write('still-alive');
      // Now check with another lock instance that reports the same
      // hostname — the probe should keep us from claiming it.
      const checker = new RecoveryLock({
        dir,
        pid: 1000,
        hostname: 'samehost',
        isPidAlive: () => true,
        sessionStore: new DefaultSessionStore({ dir }),
      });
      expect(await checker.checkAbandoned()).toBeNull();
    });

    it('returns abandonment details when the PID is dead', async () => {
      const sessionStore = new DefaultSessionStore({ dir });
      const session = await sessionStore.create({ id: 'sess', model: 'm', provider: 'p' });
      await session.append({
        type: 'user_input',
        ts: new Date().toISOString(),
        content: 'hi',
      });
      await session.close();

      const writer = new RecoveryLock({
        dir,
        pid: 31337,
        hostname: 'host',
        isPidAlive: () => false,
      });
      await writer.write(session.id);

      const checker = new RecoveryLock({
        dir,
        pid: 31338,
        hostname: 'host',
        isPidAlive: () => false,
        sessionStore,
      });
      const out = await checker.checkAbandoned();
      expect(out).not.toBeNull();
      expect(out?.sessionId).toBe(session.id);
      expect(out?.pid).toBe(31337);
      expect(out?.messageCount).toBe(1);
      expect(out?.title).toBe('hi');
      expect(out?.lastUserMessage).toBe('hi');
      expect(out?.ageMs).toBeGreaterThanOrEqual(0);
    });

    it('returns null when the session has a session_end event (clean exit)', async () => {
      const sessionStore = new DefaultSessionStore({ dir });
      const session = await sessionStore.create({ id: 'closed', model: 'm', provider: 'p' });
      await session.append({
        type: 'session_end',
        ts: new Date().toISOString(),
        usage: { input: 0, output: 0 },
      });
      await session.close();

      const writer = new RecoveryLock({ dir, pid: 1, hostname: 'h', isPidAlive: () => false });
      await writer.write(session.id);

      const checker = new RecoveryLock({
        dir,
        pid: 2,
        hostname: 'h',
        isPidAlive: () => false,
        sessionStore,
      });
      expect(await checker.checkAbandoned()).toBeNull();
    });

    it('still offers recovery when conversation continued AFTER a mid-stream session_end', async () => {
      // Legacy /save wrote session_end markers mid-session. A crash after
      // such a marker must still be recoverable — only a TRAILING
      // session_end means clean exit.
      const sessionStore = new DefaultSessionStore({ dir });
      const session = await sessionStore.create({ id: 'mid-end', model: 'm', provider: 'p' });
      await session.append({
        type: 'user_input',
        ts: new Date().toISOString(),
        content: 'q1',
      });
      await session.append({
        type: 'session_end',
        ts: new Date().toISOString(),
        usage: { input: 1, output: 1 },
      });
      // Conversation continued after the stale end marker, then crashed.
      await session.append({
        type: 'user_input',
        ts: new Date().toISOString(),
        content: 'q2 (crash after this)',
      });
      await session.close();
      // close() appends nothing — the file's last events are user_input
      // after session_end, which is what a crash-after-/save looks like.
      // Strip the trailing flush artifacts? Not needed: load() reads raw.

      const writer = new RecoveryLock({ dir, pid: 1, hostname: 'h', isPidAlive: () => false });
      await writer.write(session.id);

      const checker = new RecoveryLock({
        dir,
        pid: 2,
        hostname: 'h',
        isPidAlive: () => false,
        sessionStore,
      });
      const out = await checker.checkAbandoned();
      expect(out).not.toBeNull();
      expect(out?.sessionId).toBe(session.id);
      expect(out?.title).toBe('q1');
      expect(out?.lastUserMessage).toBe('q2 (crash after this)');
    });

    it('returns null when the lockfile is older than maxAgeMs', async () => {
      // Hand-craft a lock with a stale timestamp.
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(
        path.join(dir, 'active.json'),
        JSON.stringify({
          v: 1,
          sessionId: 'old',
          pid: 1,
          hostname: 'h',
          startedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
        }),
      );
      const checker = new RecoveryLock({
        dir,
        pid: 2,
        hostname: 'h',
        maxAgeMs: 24 * 60 * 60 * 1000,
        isPidAlive: () => false,
      });
      expect(await checker.checkAbandoned()).toBeNull();
    });

    it('returns null when the lockfile is malformed', async () => {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'active.json'), '{not json');
      const checker = new RecoveryLock({ dir, isPidAlive: () => false });
      expect(await checker.checkAbandoned()).toBeNull();
    });

    it('returns null when the lockfile points to a missing session', async () => {
      const writer = new RecoveryLock({ dir, pid: 1, hostname: 'h', isPidAlive: () => false });
      await writer.write('does-not-exist');
      const checker = new RecoveryLock({
        dir,
        pid: 2,
        hostname: 'h',
        isPidAlive: () => false,
        sessionStore: new DefaultSessionStore({ dir }),
      });
      expect(await checker.checkAbandoned()).toBeNull();
    });

    it('treats a different hostname as abandoned even if the PID looks live', async () => {
      const sessionStore = new DefaultSessionStore({ dir });
      const session = await sessionStore.create({ id: 'cross', model: 'm', provider: 'p' });
      await session.append({
        type: 'user_input',
        ts: new Date().toISOString(),
        content: 'work',
      });
      await session.close();

      const writer = new RecoveryLock({
        dir,
        pid: 1,
        hostname: 'machine-a',
        isPidAlive: () => true,
      });
      await writer.write(session.id);

      const checker = new RecoveryLock({
        dir,
        pid: 2,
        hostname: 'machine-b',
        isPidAlive: () => true,
        sessionStore,
      });
      const out = await checker.checkAbandoned();
      expect(out?.sessionId).toBe(session.id);
    });
  });

  describe('defaultIsPidAlive (live probe)', () => {
    it('returns true for our own PID', async () => {
      const lock = new RecoveryLock({ dir });
      // Indirect: write a lock pointing at our own PID, then check.
      // Since the same hostname matches and PID is alive, it should
      // return null (not abandoned).
      const sessionStore = new DefaultSessionStore({ dir });
      const session = await sessionStore.create({ id: 'self', model: 'm', provider: 'p' });
      await session.append({
        type: 'user_input',
        ts: new Date().toISOString(),
        content: 'x',
      });
      await session.close();
      await lock.write(session.id);

      const checker = new RecoveryLock({ dir, sessionStore });
      expect(await checker.checkAbandoned()).toBeNull();
    });

    it('returns false for a clearly-dead PID like 999999', async () => {
      const sessionStore = new DefaultSessionStore({ dir });
      const session = await sessionStore.create({ id: 'dead', model: 'm', provider: 'p' });
      await session.append({
        type: 'user_input',
        ts: new Date().toISOString(),
        content: 'x',
      });
      await session.close();
      // Forge a lockfile with an unlikely-to-exist PID.
      await fsp.writeFile(
        path.join(dir, 'active.json'),
        JSON.stringify({
          v: 1,
          sessionId: session.id,
          pid: 999_999_999,
          hostname: os.hostname(),
          startedAt: new Date().toISOString(),
        }),
      );
      const checker = new RecoveryLock({ dir, sessionStore });
      const out = await checker.checkAbandoned();
      expect(out?.sessionId).toBe(session.id);
    });
  });
});
