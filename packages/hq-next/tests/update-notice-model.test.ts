import { describe, expect, it } from 'vitest';
import { updateNotice } from '../src/features/update/model';

describe('updateNotice', () => {
  it('shows a newer release with the server-given command', () => {
    expect(
      updateNotice({
        current: '1.3.0',
        latest: 'v1.4.0',
        outdated: true,
        checkFailed: false,
        command: 'wstack update',
      }),
    ).toEqual({ current: '1.3.0', latest: '1.4.0', command: 'wstack update' });
  });

  it('falls back to the standard command when none is given', () => {
    expect(updateNotice({ current: '1.3.0', latest: '1.4.0', outdated: true })?.command).toBe(
      'wstack update',
    );
  });

  it('shows nothing when up to date, failed, or malformed', () => {
    expect(updateNotice(null)).toBeNull();
    expect(updateNotice({ current: '1.3.0', latest: '1.3.0', outdated: false })).toBeNull();
    expect(
      updateNotice({ current: '1.3.0', latest: '1.4.0', outdated: true, checkFailed: true }),
    ).toBeNull();
    expect(updateNotice({ current: '1.3.0', latest: '<b>x</b>', outdated: true })).toBeNull();
    expect(updateNotice({ current: 1, latest: '1.4.0', outdated: true })).toBeNull();
    expect(updateNotice({ current: '1.4.0', latest: '1.4.0', outdated: true })).toBeNull();
  });
});
