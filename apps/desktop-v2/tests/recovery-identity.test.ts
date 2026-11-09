import { describe, expect, it } from 'vitest';
import { recoveryDraft, recoveryIdentity, recoveryLayout } from '../src/recovery-identity';

describe('recovery ownership diagnostics', () => {
  it('compares every saved draft part, distinguishing pending writes and unloaded drafts', () => {
    const revisions = { text: 1, references: 2, attachments: 3, mode: 4 };
    expect(recoveryDraft({ revisions, pending: false }, { ...revisions })).toBe('match');
    expect(recoveryDraft({ revisions, pending: false }, { ...revisions, attachments: 5 })).toBe(
      'changed',
    );
    expect(recoveryDraft({ revisions, pending: true }, { ...revisions, attachments: 5 })).toBe(
      'pending',
    );
    expect(recoveryDraft(undefined, revisions)).toBe('pending');
    expect(recoveryDraft({ revisions, pending: false }, { text: 1 })).toBe('pending');
  });
  it('compares host Core identity to journal Core identity, not native row IDs', () => {
    expect(recoveryIdentity('core-a', 'core-a', false)).toBe('match');
    expect(recoveryIdentity('core-a', 'core-b', false)).toBe('mismatch');
    expect(recoveryIdentity('core-a', 'core-b', true)).toBe('pending');
    expect(recoveryIdentity(undefined, 'core-a', false)).toBe('pending');
    expect(recoveryIdentity('core-a', '', false)).toBe('pending');
  });
  it('reads restored layout pointers without leaking draft contents or trusting malformed storage', () => {
    expect(
      recoveryLayout(
        '{"project":"a","selected":"native-b","projectPage":"analytics","draft":"secret"}',
      ),
    ).toEqual({ project: 'a', selected: 'native-b', page: 'analytics' });
    expect(recoveryLayout('{')).toBeNull();
    expect(recoveryLayout(null)).toBeNull();
    expect(recoveryLayout('{"selected":5}')).toEqual({ project: '', selected: '', page: '' });
  });
});
