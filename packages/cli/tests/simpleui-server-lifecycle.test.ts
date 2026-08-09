import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/core/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWebUI } from '../src/webui-server.js';
import { openWs } from './_ws-client.js';

describe('SimpleUI embedded server lifecycle', () => {
  let frontendDir: string | undefined;
  let serverDone: Promise<void> | undefined;

  beforeEach(async () => {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
    frontendDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wrongstack-simpleui-'));
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
    if (frontendDir) await fs.rm(frontendDir, { recursive: true, force: true });
  });

  it('announces readiness and accepts a WebSocket on the shared HTTP port', async () => {
    let listeningInfo: { httpPort: number; wsPort: number; host: string; url: string } | undefined;
    let signalReady: (() => void) | undefined;
    const listening = new Promise<void>((resolve) => {
      signalReady = resolve;
    });

    serverDone = runWebUI({
      surface: 'simpleui',
      frontendDistDir: frontendDir,
      profileConfigPath: path.join(frontendDir!, 'config.json'),
      host: '127.0.0.1',
      port: 48_600,
      onListening: (info) => {
        listeningInfo = info;
        signalReady?.();
      },
      events: new EventBus(),
      session: { id: 'simpleui-lifecycle' } as never,
      agent: {
        ctx: { model: 'test-model', provider: { id: 'test-provider' } },
        run: vi.fn(),
      } as never,
    });

    await listening;
    expect(listeningInfo).toBeDefined();
    expect(listeningInfo!.httpPort).toBe(listeningInfo!.wsPort);
    expect(listeningInfo!.url).toContain(`:${listeningInfo!.httpPort}`);

    // Announced (tokenized) URL rather than a bare origin: since H3 the HTTP
    // surface requires a token on every bind, including loopback.
    const response = await fetch(listeningInfo!.url);
    expect(response.status).toBe(200);
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toContain(`ws://127.0.0.1:${listeningInfo!.httpPort}`);
    expect(csp).not.toContain('ws://127.0.0.1:3456');

    const { ws, waitForMessage } = await openWs(`ws://127.0.0.1:${listeningInfo!.wsPort}`);
    expect((await waitForMessage('session.start')).type).toBe('session.start');
    ws.close();
  });
});
