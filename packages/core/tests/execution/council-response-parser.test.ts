/**
 * Regression: optionless council questions accept a prose answer (non-JSON →
 * raw text as stance/answer), but prose that merely CONTAINED a valid JSON
 * object (a config example) parsed into that object and the seat was marked
 * invalid ("empty or missing stance") — a lost vote. An object carrying none
 * of the envelope keys is now treated like any other prose answer; option
 * questions keep the strict contract.
 */

import type { CouncilQuestion } from '@wrongstack/contracts/types/council';
import { describe, expect, it } from 'vitest';
import { parseJudge, parseVote } from '../../src/execution/council-response-parser.js';

const open = { id: 'q', prompt: 'How should we handle flaky calls?' } as unknown as CouncilQuestion;
const withOptions = {
  id: 'q',
  prompt: 'Pick one',
  options: [
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ],
} as unknown as CouncilQuestion;

describe('council response parsing', () => {
  it('accepts an optionless prose answer that contains a JSON snippet', () => {
    const text = 'Add retries with backoff, e.g. {"retries": 3, "backoff": "exp"} in the client.';
    expect(parseVote(text, open, '__r__')).toEqual({ ok: true, vote: { stance: text } });
    const judge = 'Adopt the retry plan; configure it as {"retries": 3}.';
    expect(parseJudge(judge, open, '__r__')).toEqual({ ok: true, value: { answer: judge } });
  });

  it('still uses the envelope when one is present, even wrapped in prose', () => {
    expect(parseVote('Ballot: {"stance":"Hold","rationale":"risk"} thanks', open, '__r__')).toEqual(
      {
        ok: true,
        vote: { stance: 'Hold', rationale: 'risk' },
      },
    );
  });

  it('finds the envelope when braces appear in surrounding prose or reasoning', () => {
    // First-to-last-brace slicing rejected these as invalid JSON and dropped the vote.
    const envelope = '{"optionId":"a","rationale":"faster"}';
    for (const text of [
      `Comparing {A} and {B}: A wins.\n${envelope}`,
      `<think>draft {"optionId":"b"}</think>\n${envelope}`,
      `${envelope}\nNote: config uses {placeholder}.`,
    ]) {
      expect(parseVote(text, withOptions, '__r__')).toEqual({
        ok: true,
        vote: { optionId: 'a', rationale: 'faster' },
      });
    }
    expect(parseJudge('Weighing {x}…\n{"answer":"Use A"}', open, '__r__')).toEqual({
      ok: true,
      value: { answer: 'Use A' },
    });
  });

  it('still rejects an envelope without the stance, and an empty response', () => {
    expect(parseVote('{"rationale":"because"}', open, '__r__').ok).toBe(false);
    expect(parseVote('   ', open, '__r__').ok).toBe(false);
  });

  it('keeps the strict contract for option questions', () => {
    expect(parseVote('Pick b, config {"retries": 3}', withOptions, '__r__').ok).toBe(false);
    expect(parseVote('{"optionId":"b"}', withOptions, '__r__')).toEqual({
      ok: true,
      vote: { optionId: 'b' },
    });
  });
});
