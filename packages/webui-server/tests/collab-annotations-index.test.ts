import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { AnnotateFeature } from '../src/server/collab/annotations.js';
import type { CollabContext } from '../src/server/collab/collab-context.js';

describe('AnnotateFeature atEventIndex validation', () => {
  it('rejects NaN, negative, and fractional atEventIndex values', async () => {
    const added: number[] = [];
    const ctx = {
      annotations: {
        async add(input: { atEventIndex: number }) {
          added.push(input.atEventIndex);
          return {
            id: 'a1',
            atEventIndex: input.atEventIndex,
            authorId: 'p1',
            authorRole: 'annotator',
            text: 'ok',
            createdAt: '',
            resolved: false,
          };
        },
      },
      registry: {
        findParticipant: () => ({ participantId: 'p1', sessionId: 's1', role: 'annotator' }),
      },
      send: () => {},
      errorMessage: (message: string) => ({ type: 'error', payload: { message } }),
      broadcast: () => {},
    } as unknown as CollabContext;

    const feature = new AnnotateFeature();
    await feature.handle(ctx, {} as WebSocket, { sessionId: 's1', atEventIndex: 2, text: 'ok' });
    await feature.handle(ctx, {} as WebSocket, {
      sessionId: 's1',
      atEventIndex: Number.NaN,
      text: 'bad',
    });
    await feature.handle(ctx, {} as WebSocket, { sessionId: 's1', atEventIndex: -1, text: 'bad' });
    await feature.handle(ctx, {} as WebSocket, { sessionId: 's1', atEventIndex: 1.5, text: 'bad' });

    expect(added).toEqual([2]);
  });
});
