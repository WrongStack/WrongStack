import { describe, expect, it } from 'vitest';
import { chimeraFollowup, chimeraFollowupState } from '../src/chimera-followup';
import { emptyEngineState } from '../src/engine-state';

const idle = { ...emptyEngineState, connected: true, synced: true };
describe('preparing a Chimera follow-up', () => {
  it('preserves unrelated text, references and binary draft attachments', () => {
    expect(chimeraFollowupState(idle, 'r', 'My draft', 0)).toBe('draft');
    expect(chimeraFollowupState(idle, 'r', '', 1)).toBe('draft');
    expect(chimeraFollowupState(idle, 'r', '', 0)).toBeNull();
  });
  it('recognizes an accepted refined follow-up by its original journal text', () => {
    const state = {
      ...idle,
      messages: [
        {
          id: 'u',
          role: 'user' as const,
          text: 'A refined review instruction',
          journalRaw: chimeraFollowup('r'),
        },
      ],
    };
    expect(chimeraFollowupState(state, 'r', '', 0)).toBe('sent');
  });
  it('waits for the owning conversation and refuses repeated preparation or sending', () => {
    expect(chimeraFollowupState({ ...idle, connected: false }, 'r', '', 0)).toBe('offline');
    expect(chimeraFollowupState({ ...idle, synced: false }, 'r', '', 0)).toBe('offline');
    expect(chimeraFollowupState({ ...idle, running: true }, 'r', '', 0)).toBe('running');
    const prompt = chimeraFollowup('r');
    expect(chimeraFollowupState(idle, 'r', prompt, 0)).toBe('prepared');
    expect(
      chimeraFollowupState(
        { ...idle, messages: [{ id: 'u', role: 'user', text: prompt }] },
        'r',
        '',
        0,
      ),
    ).toBe('sent');
    expect(
      chimeraFollowupState(
        { ...idle, messages: [{ id: 'u', role: 'user', text: prompt }] },
        'different',
        '',
        0,
      ),
    ).toBeNull();
  });
});
