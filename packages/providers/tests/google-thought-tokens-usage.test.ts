import type { StreamEvent, Usage } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { googleWireFormat } from '../src/presets/google.js';

/**
 * Gemini reports thinking tokens in `usageMetadata.thoughtsTokenCount`, apart
 * from `candidatesTokenCount` (totalTokenCount = prompt + thoughts + candidates).
 * They are billed as output, and every other wire already counts reasoning in
 * `Usage.output`, so dropping them under-reported each thinking turn.
 */
function streamUsage(chunks: Array<Record<string, number>>): Usage | undefined {
  const state = googleWireFormat.createStreamState('gemini-2.5-pro', 'google');
  const events: StreamEvent[] = [];
  chunks.forEach((usageMetadata, i) => {
    const last = i === chunks.length - 1;
    const data = JSON.stringify({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: `part${i}` }] },
          ...(last ? { finishReason: 'STOP' } : {}),
        },
      ],
      usageMetadata,
    });
    events.push(...googleWireFormat.parseStreamEvent({ event: 'message', data }, state));
  });
  events.push(...(googleWireFormat.finalizeStream?.(state) ?? []));
  const stop = events.find((e) => e.type === 'message_stop');
  return stop?.type === 'message_stop' ? stop.usage : undefined;
}

describe('google wire: thinking-token usage', () => {
  it('counts thoughtsTokenCount as output', () => {
    const usage = streamUsage([
      {
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        thoughtsTokenCount: 120,
        totalTokenCount: 135,
      },
    ]);
    expect(usage?.input).toBe(10);
    expect(usage?.output).toBe(125);
  });

  it('keeps an earlier thought count when a later chunk omits it', () => {
    const usage = streamUsage([
      { promptTokenCount: 10, thoughtsTokenCount: 80 },
      { promptTokenCount: 10, candidatesTokenCount: 7 },
    ]);
    expect(usage?.output).toBe(87);
  });

  it('leaves a non-thinking response unchanged', () => {
    const usage = streamUsage([{ promptTokenCount: 10, candidatesTokenCount: 5 }]);
    expect(usage).toMatchObject({ input: 10, output: 5 });
  });
});
