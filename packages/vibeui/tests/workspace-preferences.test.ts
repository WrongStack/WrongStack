import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE_PREFERENCES,
  readWorkspacePreferences,
} from '../src/lib/workspace-preferences';

describe('a calm workspace by default', () => {
  it.each([null, '', '{invalid', 'null', '[]', '42'])(
    'uses a cozy chat for missing or invalid preferences: %s',
    (raw) => {
      expect(readWorkspacePreferences(raw)).toEqual(DEFAULT_WORKSPACE_PREFERENCES);
    },
  );
  it('keeps explicit hidden extras and a chosen workspace view', () => {
    expect(
      readWorkspacePreferences(
        JSON.stringify({
          view: 'focus',
          ideas: true,
          shortcuts: false,
          guidance: false,
          collections: 'list',
          mascot: 'quiet',
          hiddenIntros: ['files', 'files', 'resources-prompts'],
        }),
      ),
    ).toEqual({
      view: 'focus',
      ideas: true,
      shortcuts: false,
      guidance: false,
      collections: 'list',
      mascot: 'quiet',
      hiddenIntros: ['files', 'resources-prompts'],
    });
  });
  it('rejects invalid fields individually while keeping valid choices', () => {
    expect(
      readWorkspacePreferences(
        JSON.stringify({
          view: 'made-up',
          ideas: 'yes',
          shortcuts: false,
          guidance: 0,
          collections: 'made-up',
          mascot: 'made-up',
          hiddenIntros: [4, null, '', '   ', 'files', 'x'.repeat(80)],
        }),
      ),
    ).toEqual({ ...DEFAULT_WORKSPACE_PREFERENCES, shortcuts: false, hiddenIntros: ['files'] });
    expect(readWorkspacePreferences('{"view":"studio"}').view).toBe('studio');
    expect(readWorkspacePreferences(null).hiddenIntros).not.toBe(
      DEFAULT_WORKSPACE_PREFERENCES.hiddenIntros,
    );
  });
});
