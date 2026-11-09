import { describe, expect, it } from 'vitest';
import { emptyEngineState, replayEngineBatch } from '../src/engine-state';
import { transcriptFileName, transcriptTitle } from '../src/transcript-export';
import { dayLabel, replayProgress, transcriptSearchText } from '../src/transcript-window';

describe('find in conversation', () => {
  it('searches one line per message, by its visible text', () => {
    const text = transcriptSearchText([
      { role: 'user', text: 'first\nprompt' },
      { role: 'assistant', text: 'an\n\nanswer' },
    ]);
    expect(text.split('\n')).toEqual(['first prompt', 'an answer']);
  });
});

describe('replay progress', () => {
  it('says how far a first read of the journal got, until it catches up', () => {
    const mb = 1024 * 1024;
    const reading = replayEngineBatch(emptyEngineState, [], true, { read: 3 * mb, total: 12 * mb });
    expect(reading.replay && replayProgress(reading.replay)).toBe('25% · 3.0 MB of 12.0 MB');
    expect(
      replayEngineBatch(reading, [], false, { read: 12 * mb, total: 12 * mb }).replay,
    ).toBeNull();
    expect(replayEngineBatch(emptyEngineState, [], true).replay).toBeNull();
  });
});

describe('day separators', () => {
  const at = (month: number, day: number, hour = 12, minute = 0) =>
    new Date(2026, month - 1, day, hour, minute).getTime();

  it('reads the previous local calendar day as Yesterday across a DST change', () => {
    const original = process.env.TZ;
    process.env.TZ = 'Europe/Berlin';
    try {
      // 2026-03-29 is 23 hours long in Berlin; 2026-10-25 is 25 hours long.
      expect(dayLabel({ at: at(3, 29) }, { at: at(3, 27) }, at(3, 30, 0, 30))).toBe('Yesterday');
      expect(dayLabel({ at: at(10, 25) }, { at: at(10, 23) }, at(10, 26, 0, 30))).toBe('Yesterday');
      expect(dayLabel({ at: at(3, 30, 9) }, { at: at(3, 29) }, at(3, 30, 23))).toBe('Today');
      expect(dayLabel({ at: at(3, 30) }, { at: at(3, 30, 9) }, at(3, 30, 23))).toBeUndefined();
    } finally {
      process.env.TZ = original;
    }
  });

  it('guards zero/non-finite replay progress, invalid timestamps, and unsafe folder segments (F103)', () => {
    expect(replayProgress({ read: 0, total: 0 })).toBe('0% · 0.0 MB of 0.0 MB');
    expect(dayLabel({ at: 1e20 }, undefined)).toBeUndefined();
    expect(transcriptTitle('/work/my-app   ')).toBe('my-app');
    expect(transcriptFileName('/work/..', '2026-11-04T10:30:00Z')).toBe(
      'conversation-chat-2026-11-04-10-30-00.md',
    );
  });
});
