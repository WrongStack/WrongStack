import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TopicCheckPanel } from '../src/components/topic-check-panel.js';

describe('TopicCheckPanel', () => {
  it('shows a bounded prompt preview and explains why the submit is paused', () => {
    const prompt = `Plan a separate deployment architecture ${'detail '.repeat(80)}`;
    const { lastFrame, unmount } = render(<TopicCheckPanel prompt={prompt} />);

    const frame = lastFrame() ?? '';
    expect(frame).toContain('CONTEXT ADVISOR');
    expect(frame).toContain('CHECKING TOPIC CONTINUITY');
    expect(frame).toContain('Long history detected');
    expect(frame).toContain('Plan a separate deployment architecture');
    expect(frame).not.toContain('detail '.repeat(40));
    unmount();
  });
});
