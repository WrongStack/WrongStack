/**
 * The interview title is cut to 64 chars. A raw `slice(0, 63)` split an emoji
 * that straddled the cut and left a lone high surrogate in the title, which is
 * not a well-formed string. The shared truncate backs off the high surrogate.
 */
import type { RequirementIntakeRecord } from '@wrongstack/requirement-intake';
import { describe, expect, it } from 'vitest';
import { intakeToInterviewKickoff } from '../src/intake-kickoff.js';

function record(title: string): RequirementIntakeRecord {
  return {
    title,
    originalRequest: 'Do the thing',
    targetUsers: [],
    constraints: [],
    providedContext: [],
  } as unknown as RequirementIntakeRecord;
}

describe('intakeToInterviewKickoff title truncation', () => {
  it('never splits a surrogate pair at the cut', () => {
    const title = intakeToInterviewKickoff(
      record(`${'a'.repeat(62)}🚀 launch the new onboarding flow for every team`),
    ).title;
    expect(title.isWellFormed()).toBe(true);
    expect(title).toBe(`${'a'.repeat(62)}…`);
  });

  it('keeps an emoji that ends before the cut', () => {
    const title = intakeToInterviewKickoff(
      record(`${'a'.repeat(61)}🚀 launch the new onboarding flow for every team`),
    ).title;
    expect(title).toBe(`${'a'.repeat(61)}🚀…`);
  });

  it('still trims trailing whitespace before the ellipsis', () => {
    const title = intakeToInterviewKickoff(record(`${'a'.repeat(60)}   ${'b'.repeat(20)}`)).title;
    expect(title).toBe(`${'a'.repeat(60)}…`);
  });
});
