import { expect, it } from 'vitest';
import { reviewText } from '../src/file-model';
import {
  MAX_REVIEW_REPLIES,
  parseReviewNotes,
  withReply,
  withReplyChange,
  withResolved,
} from '../src/review-notes-store';

const note = { path: 'src/a.ts', line: 4, text: 'Check the empty case.' };
const at = '2026-10-29T10:00:00.000Z';

it('keeps a reply thread and resolution on a note', () => {
  const replied = withReply([note], 0, '  Covered by the guard.  ', at);
  expect(replied).toEqual([{ ...note, replies: [{ text: 'Covered by the guard.', at }] }]);
  const resolved = withResolved(replied, 0, true);
  expect(resolved[0]!.resolved).toBe(true);
  expect(withResolved(resolved, 0, false)[0]).not.toHaveProperty('resolved');
  // Blank replies and missing notes change nothing.
  expect(withReply([note], 0, '   ', at)).toEqual([note]);
  expect(withReply([note], 3, 'x', at)).toEqual([note]);
});
it('refuses a reply past the limit', () => {
  const full = {
    ...note,
    replies: Array.from({ length: MAX_REVIEW_REPLIES }, (_, i) => ({ text: `r${i}`, at })),
  };
  expect(() => withReply([full], 0, 'one more', at)).toThrow('at most');
});
it('reads version 1 notes and validates version 2 discussions', () => {
  expect(parseReviewNotes({ version: 1, notes: [note] })).toEqual([note]);
  const saved = { ...note, resolved: true, replies: [{ text: 'Done.', at }] };
  expect(parseReviewNotes({ version: 2, notes: [saved] })).toEqual([saved]);
  for (const bad of [
    { version: 1, notes: [{ ...note, resolved: true }] },
    { version: 2, notes: [{ ...note, resolved: 'yes' }] },
    { version: 2, notes: [{ ...note, replies: [{ text: ' ', at }] }] },
    { version: 2, notes: [{ ...note, replies: [{ text: 'x', at: 'not a time' }] }] },
    { version: 3, notes: [] },
  ])
    expect(() => parseReviewNotes(bad)).toThrow('unsupported');
});
it('sends open notes with their replies and leaves resolved notes out', () => {
  const open = { ...note, replies: [{ text: 'Covered.', at }] };
  const done = { path: 'src/b.ts', line: 1, text: 'Rename.', resolved: true };
  expect(reviewText([open, done])).toBe('src/a.ts:4\nCheck the empty case.\nReply: Covered.');
});
it('edits and deletes a single reply', () => {
  const replied = withReply(withReply([note], 0, 'first', at), 0, 'second', at);
  expect(withReplyChange(replied, 0, 1, '  changed ')[0]!.replies!.map((r) => r.text)).toEqual([
    'first',
    'changed',
  ]);
  expect(withReplyChange(replied, 0, 0, null)[0]!.replies!.map((r) => r.text)).toEqual(['second']);
  // Deleting the last reply leaves no empty replies field behind.
  expect(withReplyChange(withReply([note], 0, 'only', at), 0, 0, null)[0]).toEqual(note);
  expect(() => withReplyChange(replied, 0, 0, '   ')).toThrow('cannot be empty');
  expect(withReplyChange(replied, 0, 9, 'x')).toBe(replied);
});
