import type { Request } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import {
  type CodexWebSocketLike,
  type CodexWebSocketOptions,
  defaultCodexWebSocketFactory,
} from '../src/codex-websocket.js';
import { type CodexResponseMetadata, OpenAICodexProvider } from '../src/openai-codex.js';

const enabled = process.env.WRONGSTACK_CODEX_LIVE === '1';
const accessToken = process.env.WRONGSTACK_CODEX_ACCESS_TOKEN?.trim();
const model = process.env.WRONGSTACK_CODEX_MODEL?.trim() || 'gpt-6-astra';

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
      on(...[event, listener]: Parameters<CodexWebSocketLike['on']>): CodexWebSocketLike {
        socket.on(event, listener);
        return this;
      },
      once(...[event, listener]: Parameters<CodexWebSocketLike['once']>): CodexWebSocketLike {
        socket.once(event, listener);
        return this;
      },
      removeListener(
        ...[event, listener]: Parameters<CodexWebSocketLike['removeListener']>
      ): CodexWebSocketLike {
        socket.removeListener(event, listener);
        return this;
      },
    };
  };
}

function request(sessionId: string, text: string): Request {
  return {
    model,
    system: [{ type: 'text', text: 'Reply briefly.' }],
    messages: [{ role: 'user', content: text }],
    cache: { sessionId },
  };
}

describe.skipIf(!enabled || !accessToken)('Codex live WebSocket integration (opt-in)', () => {
  it('prewarms the connection, chains real response ids, and captures turn-state metadata', async () => {
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

    const firstRequest = request(sessionId, 'Reply with exactly OK.');
    const first = await provider.complete(firstRequest, { signal });
    expect(
      first.content.some((block) => block.type === 'text' && block.text.trim().length > 0),
    ).toBe(true);
    const secondRequest = request(sessionId, 'Reply with exactly SECOND.');
    const second = await provider.complete(
      {
        ...secondRequest,
        messages: [
          ...firstRequest.messages,
          { role: 'assistant', content: first.content },
          ...secondRequest.messages,
        ],
      },
      { signal },
    );
    expect(
      second.content.some((block) => block.type === 'text' && block.text.trim().length > 0),
    ).toBe(true);

    const prewarm = frames.find((frame) => frame['generate'] === false);
    const turns = frames.filter((frame) => frame['generate'] !== false);
    expect(prewarm).toMatchObject({ type: 'response.create', generate: false });
    expect(Array.isArray(prewarm?.['input']) && prewarm['input'].length > 0).toBe(true);
    expect(turns.length).toBeGreaterThanOrEqual(2);
    expect(typeof turns[0]?.['previous_response_id']).toBe('string');
    expect(turns[0]?.['input']).toEqual([]);
    // The second real turn must reuse the first generated response, not merely
    // prove the warmup id was used for the first turn.
    expect(typeof turns[1]?.['previous_response_id']).toBe('string');
    expect(turns[1]?.['previous_response_id']).not.toBe(turns[0]?.['previous_response_id']);
    expect(turns[1]?.['input']).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly SECOND.' }] },
    ]);
    expect(connectionHeaders[0]?.authorization === 'Bearer <present>').toBe(true);
    expect(metadata.some((entry) => Boolean(entry.headers['x-codex-turn-state']))).toBe(true);
  }, 120_000);
});
