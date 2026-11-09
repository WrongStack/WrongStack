import { describe, expect, it } from 'vitest';
import { parseAppearance } from '../src/appearance';
import { conversationDisplay } from '../src/conversation-appearance';

describe('persisted conversation appearance', () => {
  it('reads old appearance records with compatible native defaults', () => {
    expect(conversationDisplay(parseAppearance('{"mode":"dark"}'))).toEqual({
      showThinkingLogs: true,
      groupToolCalls: true,
      autoCollapseInput: false,
      keyboardShortcuts: true,
    });
  });
  it('round-trips explicit Boolean choices through the native appearance payload', () => {
    const choices = {
      showThinkingLogs: false,
      groupToolCalls: false,
      autoCollapseInput: true,
      keyboardShortcuts: false,
    };
    const appearance = parseAppearance(JSON.stringify({ mode: 'dark', ...choices }));
    expect(conversationDisplay(parseAppearance(JSON.stringify(appearance)))).toEqual(choices);
    expect(appearance.mode).toBe('dark');
  });
  it('rejects malformed preference values instead of interpreting strings as enabled', () => {
    expect(
      conversationDisplay(
        parseAppearance(
          JSON.stringify({
            showThinkingLogs: 'false',
            groupToolCalls: [],
            autoCollapseInput: 1,
            keyboardShortcuts: null,
          }),
        ),
      ),
    ).toEqual(conversationDisplay());
  });
});
