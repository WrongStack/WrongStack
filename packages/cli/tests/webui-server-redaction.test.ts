import { EventBus } from '@wrongstack/core/kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runWebUI } from '../src/webui-server.js';
import { openWs } from './_ws-client.js';

const ports = { next: 45_570 };

function nextPort(): number {
  return ports.next++;
}

describe('runWebUI redaction', () => {
  afterEach(() => {
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('SIGTERM');
  });

  it('redacts secrets from tool event input/output before broadcasting to WebSocket clients', async () => {
    const port = nextPort();
    const httpPort = port; // single-port design: HTTP and WS share one listener
    const events = new EventBus();
    // Port resolution made startup async, so wait for the server to report
    // it's listening before connecting (the old immediate-connect was racy).
    let signalReady: (() => void) | undefined;
    const listening = new Promise<void>((r) => {
      signalReady = r;
    });
    const serverDone = runWebUI({
      port,
      httpPort,
      profileConfigPath: '/tmp/test-profile.json',
  onListening: () => signalReady?.(),
      events,
      session: { id: 'test-session' } as any,
      agent: {
        ctx: {
          model: 'test-model',
          provider: { id: 'test-provider' },
        },
        run: vi.fn(),
      } as any,
    });

    await listening;
    const { ws, waitForMessage } = await openWs(`ws://127.0.0.1:${port}`);
    await waitForMessage('session.start');

    const openAiKey = `sk-${'1234567890'.repeat(3)}`;
    const bearer = `Bearer ${'abcdefghijklmnopqrstuvwxyz123456'}`;
    const secondOpenAiKey = `sk-${'abcdefghijklmnopqrstuvwxyz123456'}`;

    events.emit('tool.started', {
      id: 'tool-1',
      name: 'fetch',
      input: { url: `https://example.com?token=${openAiKey}` },
    });
    const started = await waitForMessage('tool.started');
    expect(JSON.stringify(started.payload)).not.toContain(openAiKey);
    expect(JSON.stringify(started.payload)).toContain('[REDACTED:openai_key]');

    events.emit('tool.executed', {
      id: 'tool-1',
      name: 'fetch',
      durationMs: 3,
      ok: true,
      input: { authorization: bearer },
      output: `result contains ${secondOpenAiKey}`,
    });
    const executed = await waitForMessage('tool.executed');
    expect(JSON.stringify(executed.payload)).not.toContain(bearer);
    expect(JSON.stringify(executed.payload)).not.toContain(secondOpenAiKey);
    expect(JSON.stringify(executed.payload)).toContain('[REDACTED:bearer_token]');
    expect(JSON.stringify(executed.payload)).toContain('[REDACTED:openai_key]');

    ws.close();
    process.emit('SIGTERM');
    await serverDone;
  });
});
