/**
 * A daemon's metadata file can be overwritten by a daemon of another release.
 *
 * When the endpoint name changes between releases, an old and a new process
 * elect different endpoints for one project, and both write the same
 * metadata file. Whichever wrote last owns the token every client reads;
 * clients of the other daemon were refused on every request (the 1.0.27
 * upgrade's `UnauthorizedSageRequest`). The owner now puts its file back on a
 * refused token, and clients retry with a re-read token.
 */
import { EventEmitter } from 'node:events';
import * as fs from 'node:fs/promises';
import type net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  bindProjectEndpoint,
  createProjectMetadataReasserter,
  retryWhileUnauthorized,
} from '../src/project-endpoint.js';

const OWN = { pid: 4242, endpoint: '/tmp/ws/daemon-new.sock', authToken: 'own' };

async function setup(initial: unknown) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-reassert-'));
  const metadataPath = path.join(dir, 'server.json');
  if (initial !== undefined) {
    await fs.writeFile(
      metadataPath,
      typeof initial === 'string' ? initial : JSON.stringify(initial),
    );
  }
  const write = vi.fn(async () => {
    await fs.writeFile(metadataPath, JSON.stringify(OWN));
  });
  const guard = createProjectMetadataReasserter({
    metadataPath,
    endpoint: OWN.endpoint,
    pid: OWN.pid,
    write,
  });
  const read = async () => JSON.parse(await fs.readFile(metadataPath, 'utf8')) as typeof OWN;
  return { guard, write, read };
}

describe('createProjectMetadataReasserter', () => {
  it('puts its own file back when another daemon wrote it', async () => {
    const { guard, write, read } = await setup({ ...OWN, pid: 68612, authToken: 'theirs' });
    guard.enable();
    await guard.reassert();
    expect(write).toHaveBeenCalledTimes(1);
    expect(await read()).toEqual(OWN);
  });

  it('treats the same pid on another endpoint as another daemon', async () => {
    const { guard, write } = await setup({ ...OWN, endpoint: '/tmp/ws/daemon-old.sock' });
    guard.enable();
    await guard.reassert();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('rewrites a missing or unreadable file', async () => {
    const missing = await setup(undefined);
    missing.guard.enable();
    await missing.guard.reassert();
    expect(missing.write).toHaveBeenCalledTimes(1);

    const garbled = await setup('{not json');
    garbled.guard.enable();
    await garbled.guard.reassert();
    expect(garbled.write).toHaveBeenCalledTimes(1);
  });

  it('leaves a file that names this daemon alone (a caller who guessed costs one read)', async () => {
    const { guard, write } = await setup(OWN);
    guard.enable();
    await guard.reassert();
    expect(write).not.toHaveBeenCalled();
  });

  it('does nothing before enable() or after disable()', async () => {
    const { guard, write } = await setup({ ...OWN, pid: 1 });
    await guard.reassert();
    guard.enable();
    guard.disable();
    await guard.reassert();
    expect(write).not.toHaveBeenCalled();
  });

  it('coalesces concurrent refusals into one write', async () => {
    const { guard, write } = await setup({ ...OWN, pid: 1 });
    guard.enable();
    await Promise.all([guard.reassert(), guard.reassert(), guard.reassert()]);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('never throws when the write fails, and tries again on the next refusal', async () => {
    const { guard, write } = await setup({ ...OWN, pid: 1 });
    write.mockRejectedValueOnce(new Error('EBUSY'));
    guard.enable();
    await expect(guard.reassert()).resolves.toBeUndefined();
    await guard.reassert();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('re-checks and rewrites when a foreign overwrite and new refusal arrive during an in-flight write (F675)', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'metadata-reassert-f675-'));
    const metadataPath = path.join(dir, 'server.json');
    const THEIRS = { pid: 9999, endpoint: '/tmp/ws/daemon-old.sock', authToken: 'theirs' };
    try {
      await fs.writeFile(metadataPath, JSON.stringify(THEIRS));
      let writes = 0;
      let concurrentReassert: Promise<void> | undefined;
      const guard = createProjectMetadataReasserter({
        metadataPath,
        endpoint: OWN.endpoint,
        pid: OWN.pid,
        write: async () => {
          writes++;
          await fs.writeFile(metadataPath, JSON.stringify(OWN));
          if (writes === 1) {
            await fs.writeFile(metadataPath, JSON.stringify(THEIRS));
            concurrentReassert = guard.reassert();
          }
        },
      });
      guard.enable();
      await guard.reassert();
      if (concurrentReassert) await concurrentReassert;
      expect(writes).toBe(2);
      expect(JSON.parse(await fs.readFile(metadataPath, 'utf8'))).toEqual(OWN);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('rewrites when authToken is blank or mismatches the expected daemon authToken (F35)', async () => {
    const blankToken = await setup({ ...OWN, authToken: '   ' });
    blankToken.guard.enable();
    await blankToken.guard.reassert();
    expect(blankToken.write).toHaveBeenCalledTimes(1);
  });
});

describe('retryWhileUnauthorized', () => {
  const unauthorized = () => Object.assign(new Error('refused'), { name: 'UnauthorizedX' });
  const isUnauthorized = (error: unknown) => (error as Error).name === 'UnauthorizedX';

  it('returns the first success without waiting', async () => {
    const attempt = vi.fn(async () => 'ok');
    await expect(retryWhileUnauthorized(attempt, isUnauthorized)).resolves.toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries a refused request until it goes through', async () => {
    const attempt = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(unauthorized())
      .mockRejectedValueOnce(unauthorized())
      .mockResolvedValue('ok');
    await expect(retryWhileUnauthorized(attempt, isUnauthorized, { delayMs: 1 })).resolves.toBe(
      'ok',
    );
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('does not retry any other error', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(retryWhileUnauthorized(attempt, isUnauthorized, { delayMs: 1 })).rejects.toThrow(
      'boom',
    );
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('gives up after its budget with the refusal', async () => {
    const attempt = vi.fn(async () => {
      throw unauthorized();
    });
    await expect(
      retryWhileUnauthorized(attempt, isUnauthorized, { attempts: 2, delayMs: 1 }),
    ).rejects.toThrow('refused');
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('executes coalesced rerun even if the first write throws a transient error and clamps bindProjectEndpoint maxAttempts to at least 1 (F769)', async () => {
    const { guard, write, read } = await setup({ ...OWN, pid: 99999, authToken: 'other' });
    let unblockFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      unblockFirst = resolve;
    });
    let firstEntered!: () => void;
    const enteredPromise = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });

    write.mockImplementationOnce(async () => {
      firstEntered();
      await firstBlocked;
      throw new Error('EBUSY: transient rename failure');
    });

    guard.enable();
    const firstCall = guard.reassert();
    await enteredPromise;
    const secondCall = guard.reassert();
    unblockFirst();
    await Promise.all([firstCall, secondCall]);

    expect(write).toHaveBeenCalledTimes(2);
    expect(await read()).toEqual(OWN);

    let listenCalls = 0;
    const fakeServer = Object.assign(new EventEmitter(), {
      listen() {
        listenCalls += 1;
        queueMicrotask(() => fakeServer.emit('listening'));
        return fakeServer;
      },
    }) as unknown as net.Server;

    const bindOutcome = await bindProjectEndpoint({
      server: fakeServer,
      endpoint: '\\\\.\\pipe\\ws-f769-zero-attempts',
      service: 'test-svc',
      maxAttempts: 0,
    });
    expect(bindOutcome.outcome).toBe('bound');
    expect(listenCalls).toBe(1);
  });
});
