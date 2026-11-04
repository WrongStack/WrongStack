import { describe, expect, it } from 'vitest';
import { emptyEngineState, replayEngineBatch } from '../src/engine-state';
import {
  hiddenMessageCount,
  replayProgress,
  TRANSCRIPT_WINDOW,
  transcriptSearchText,
} from '../src/transcript-window';

describe('conversation rendering window', () => {
  it('renders the newest messages and counts the earlier ones', () => {
    expect(hiddenMessageCount(40, TRANSCRIPT_WINDOW)).toBe(0);
    expect(hiddenMessageCount(400, TRANSCRIPT_WINDOW)).toBe(250);
    expect(hiddenMessageCount(400, TRANSCRIPT_WINDOW * 3)).toBe(0);
    expect(hiddenMessageCount(5, -1)).toBe(5);
  });
});

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
