import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { conversationDisplay } from '../src/conversation-appearance';
import { SessionActivity } from '../src/SessionActivity';
import { LiveRunActivity, TurnTools } from '../src/TurnTools';

const events = [
  { type: 'provider.thinking_delta', payload: { text: 'Private reasoning fixture' } },
  { type: 'tool.started', payload: { id: 'one', name: 'read', input: { path: 'README.md' } } },
  {
    type: 'tool.executed',
    payload: { id: 'one', name: 'read', ok: true, output: 'Retained tool evidence' },
  },
  { type: 'tool.started', payload: { id: 'two', name: 'read', input: { path: 'other.md' } } },
  {
    type: 'tool.executed',
    payload: { id: 'two', name: 'read', ok: true, output: 'Second tool evidence' },
  },
];

describe('conversation display controls', () => {
  it('hides reasoning without losing tool evidence or changing its source events', () => {
    const shown = renderToStaticMarkup(
      createElement(SessionActivity, { events, onOpenFile: () => {} }),
    );
    const hidden = renderToStaticMarkup(
      createElement(SessionActivity, { events, showThinkingLogs: false, onOpenFile: () => {} }),
    );
    expect(shown).toContain('Private reasoning fixture');
    expect(hidden).not.toContain('Private reasoning fixture');
    expect(hidden).toContain('Retained tool evidence');
    expect(hidden).toContain('Second tool evidence');
    expect(events[0]?.payload.text).toBe('Private reasoning fixture');
  });
  it('shows individual tool entries when grouping is disabled, for live and finished turns', () => {
    for (const component of [LiveRunActivity, TurnTools]) {
      const grouped = renderToStaticMarkup(
        createElement(component, { events, onOpenFile: () => {} }),
      );
      const separate = renderToStaticMarkup(
        createElement(component, {
          events,
          display: conversationDisplay({ groupToolCalls: false, showThinkingLogs: false }),
          onOpenFile: () => {},
        }),
      );
      expect(grouped).toContain('chat-run-activity');
      expect(separate).not.toContain('chat-run-activity');
      expect(separate.match(/activity-entry activity-done/g)).toHaveLength(2);
      expect(separate).toContain('Retained tool evidence');
      expect(separate).not.toContain('Private reasoning fixture');
    }
  });
  it('does not leave an empty reasoning-only transcript block when reasoning is hidden', () => {
    expect(
      renderToStaticMarkup(
        createElement(LiveRunActivity, {
          events: events.slice(0, 1),
          display: conversationDisplay({ showThinkingLogs: false }),
          onOpenFile: () => {},
        }),
      ),
    ).toBe('');
  });
});
