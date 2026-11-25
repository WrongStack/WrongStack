import { describe, expect, it } from 'vitest';
import type { buildSessionStory } from '../src/story/session-story';
import { storyStats } from '../src/story/session-story-stats';

describe('storyStats non-finite durationMs guard', () => {
  it('ignores NaN and negative tool durations instead of poisoning avg and total', () => {
    type Story = ReturnType<typeof buildSessionStory>;
    const res = storyStats({
      files: [],
      events: [
        {
          id: 'e1',
          actor: 'leader',
          durationMs: 100,
          raw: {
            eventType: 'tool.executed',
            outcome: 'success',
            correlation: { toolCallId: 'c1' },
            attributes: { toolName: 'read' },
          },
        },
        {
          id: 'e2',
          actor: 'leader',
          durationMs: Number.NaN,
          raw: {
            eventType: 'tool.executed',
            outcome: 'success',
            correlation: { toolCallId: 'c2' },
            attributes: { toolName: 'read' },
          },
        },
      ],
    } as unknown as Story);
    expect(res.tools[0]?.measured).toBe(1);
    expect(res.tools[0]?.avg).toBe(100);
    expect(res.tools[0]?.total).toBe(100);
  });
});
