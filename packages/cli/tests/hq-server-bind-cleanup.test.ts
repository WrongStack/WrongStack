import { mkdtempSync, rmSync } from 'node:fs';
import * as http from 'node:http';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startHqServer } from '../src/hq-server.js';

const tempDirs: string[] = [];

describe('startHqServer bind failure cleanup (F195)', () => {
  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it('clears pre-listen intervals when strictPort bind fails with EADDRINUSE', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'hq-bind-cleanup-'));
    tempDirs.push(dir);
    const blocker = http.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const occupiedPort = (blocker.address() as { port: number }).port;

    const origSetInterval = globalThis.setInterval;
    const origClearInterval = globalThis.clearInterval;
    const liveIntervals = new Set<ReturnType<typeof setInterval>>();

    globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
      const id = origSetInterval(...args);
      liveIntervals.add(id);
      return id;
    }) as typeof setInterval;

    globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
      if (id !== undefined) liveIntervals.delete(id);
      return origClearInterval(id);
    }) as typeof clearInterval;

    try {
      await expect(
        startHqServer({
          host: '127.0.0.1',
          port: occupiedPort,
          strictPort: true,
          dataDir: dir,
          requireBrowserAuth: false,
        }),
      ).rejects.toThrow();

      expect(liveIntervals.size).toBe(0);
    } finally {
      for (const id of liveIntervals) origClearInterval(id);
      globalThis.setInterval = origSetInterval;
      globalThis.clearInterval = origClearInterval;
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
