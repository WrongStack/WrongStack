import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/core/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Force the TOCTOU race deterministically: `findFreePort` claims the
// requested port is free while a real holder occupies it, so the deferred
// bind (startDeferredHttpListen → listenWithRetry) must advance and
// runWebUI's reconciliation must re-point httpPort/wsPort/accessUrl.
vi.mock('@wrongstack/webui-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@wrongstack/webui-server')>();
  return { ...actual, findFreePort: vi.fn(async () => 48_700) };
});

import { runWebUI } from '../src/webui-server.js';

describe('SimpleUI deferred-listen port-advance reconciliation', () => {
  let frontendDir: string | undefined;
  let holder: net.Server | undefined;
  let serverDone: Promise<void> | undefined;

  beforeEach(async () => {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    frontendDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-deferred-'));
    await fs.writeFile(
      path.join(frontendDir, 'index.html'),
      '<!doctype html><html><head></head><body>SimpleUI</body></html>',
      'utf8',
    );
  });

  afterEach(async () => {
    if (serverDone) {
      process.emit('SIGTERM');
      await serverDone;
      serverDone = undefined;
    }
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    await new Promise<void>((resolve) => {
      if (holder) {
        holder.close(() => resolve());
        holder = undefined;
      } else {
        resolve();
      }
    });
    if (frontendDir) await fs.rm(frontendDir, { recursive: true, force: true });
  });

  it('re-points httpPort, wsPort, and the access URL at the actually-bound port', async () => {
    const busyPort = 48_700;
    // Real competitor holding the "probed-free" port.
    holder = net.createServer();
    await new Promise<void>((resolve) => holder!.listen(busyPort, '127.0.0.1', resolve));

    let info: { httpPort: number; wsPort: number; host: string; url: string } | undefined;
    let signalReady: (() => void) | undefined;
    const listening = new Promise<void>((resolve) => {
      signalReady = resolve;
    });

    serverDone = runWebUI({
      surface: 'simpleui',
      frontendDistDir: frontendDir,
      profileConfigPath: path.join(frontendDir!, 'config.json'),
      host: '127.0.0.1',
      port: busyPort,
      onListening: (payload) => {
        info = payload;
        signalReady?.();
      },
      events: new EventBus(),
      session: { id: 'deferred-advance' } as never,
      agent: {
        ctx: { model: 'test-model', provider: { id: 'test-provider' } },
        run: vi.fn(),
      } as never,
    });

    await listening;
    expect(info).toBeDefined();

    // The reconciliation block must carry the ADVANCED port everywhere:
    // HTTP and WS share it, and the advertised URL points at it — never at
    // the busy port the probe claimed was free.
    expect(info!.httpPort).toBe(busyPort + 1);
    expect(info!.wsPort).toBe(busyPort + 1);
    expect(info!.url).toContain(`:${busyPort + 1}`);
    expect(info!.url).not.toContain(`:${busyPort}`);

    // The advertised URL is genuinely live on the advanced port.
    const response = await fetch(info!.url);
    expect(response.status).toBe(200);
  });
});
