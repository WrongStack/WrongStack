import type { Request, StreamEvent } from '@wrongstack/core/types';
import { describe, expect, it } from 'vitest';
import {
  defaultCodexWebSocketFactory,
  type CodexWebSocketLike,
  type CodexWebSocketOptions,
} from '../src/codex-websocket.js';
import { OpenAICodexProvider, type CodexResponseMetadata } from '../src/openai-codex.js';

const enabled = process.env.WRONGSTACK_CODEX_LIVE === '1';
const accessToken = process.env.WRONGSTACK_CODEX_ACCESS_TOKEN?.trim();
const model = process.env.WRONGSTACK_CODEX_MODEL?.trim() || 'gpt-5-codex';

type Frame = Record<string, unknown>;

function observingFactory(
  frames: Frame[],
  connectionHeaders: Array<Record<string, string>>,
): (url: string, options: CodexWebSocketOptions) => CodexWebSocketLike {
  return (url, options) => {
    connectionHeaders.push({
      ...options.headers,
      ...(options.headers.authorization ? { authorization: 'Bearer <present>' } : {}),
    });
    const socket = defaultCodexWebSocketFactory(url, options);
    return {
      get readyState() {
        return socket.readyState;
      },
      send(data: string): void {
        // Store only the parsed envelope; never log or retain authorization headers.
        frames.push(JSON.parse(data) as Frame);
        socket.send(data);
      },
      close(): void {
        socket.close();
      },
      on(event: string, listener: (...args: any[]) => void): CodexWebSocketLike {
        socket.on(event, listener);
        return this;
      },
      once(event: string, listener: (...args: any[]) => void): CodexWebSocketLike {
        socket.once(event, listener);
        return this;
      },
      removeListener(event: string, listener: (...args: any[]) => void): CodexWebSocketLike {
        socket.removeListener(event, listener);
        return this;
      },
    };
  };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function request(sessionId: string, text: string): Request {
  return {
    model,
    messages: [{ role: 'user', content: text }],
    cache: { sessionId },
  };
}

describe.skipIf(!enabled || !accessToken)('Codex live WebSocket integration (opt-in)', () => {
  it('prewarms, chains response ids, and captures turn-state metadata', async () => {
    const frames: Frame[] = [];
    const connectionHeaders: Array<Record<string, string>> = [];
    const metadata: CodexResponseMetadata[] = [];
    const provider = new OpenAICodexProvider({
      credentials: { accessToken: accessToken! },
      webSocket: true,
      webSocketPrewarm: true,
      webSocketFactory: observingFactory(frames, connectionHeaders),
      onResponseMetadata: (value) => metadata.push(value),
    });
    const sessionId = `live-ws-${Date.now().toString(36)}`;
    const signal = AbortSignal.timeout(90_000);

    await collect(provider.stream(request(sessionId, 'Reply with exactly OK.'), { signal }));
    await collect(provider.stream(request(sessionId, 'Reply with exactly SECOND.'), { signal }));

    const prewarm = frames.find((frame) => frame['generate'] === false);
    const turns = frames.filter((frame) => frame['generate'] !== false);
    expect(prewarm).toMatchObject({
      type: 'response.create',
      input: [],
      generate: false,
      stream: true,
      store: false,
    });
    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(typeof turns[1]?.['previous_response_id']).toBe('string');
    expect(connectionHeaders[0]?.authorization?.startsWith('Bearer ')).toBe(true);
    expect(connectionHeaders[0]?.authorization).not.toBe(accessToken);
    expect(metadata.some((entry) => Boolean(entry.headers['x-codex-turn-state']))).toBe(true);
  }, 120_000);
});
