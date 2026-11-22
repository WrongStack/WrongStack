/**
 * The LLM conflict resolver's prompt allows the resolved file "optionally
 * wrapped in a single ``` code fence". Unwrapping used to match the FIRST fence
 * anywhere in the reply, so an unwrapped Markdown file lost everything before
 * its first and after its last inner code block, and the truncated text was
 * written back as a successful resolution.
 */
import { describe, expect, it } from 'vitest';
import { makeLlmConflictResolver } from '../src/conflict-resolver.js';

const task = {
  id: 't',
  title: 't',
  description: '',
  type: 'docs',
  priority: 'low',
  status: 'pending',
  createdAt: 0,
  updatedAt: 0,
} as never;

function memIO(initial: string) {
  let content = initial;
  return {
    io: {
      read: async () => content,
      write: async (_path: string, next: string) => {
        content = next;
      },
    },
    get: () => content,
  };
}

const CODE = Array.from({ length: 12 }, (_, i) => `const v${i} = ${i};`);
const MARKDOWN_CONFLICT = [
  '# Guide',
  '<<<<<<< HEAD',
  'Intro from base.',
  '=======',
  'Intro from task.',
  '>>>>>>> task',
  '```js',
  ...CODE,
  '```',
  'Closing notes.',
].join('\n');
const MARKDOWN_RESOLVED = [
  '# Guide',
  'Intro merged.',
  '```js',
  ...CODE,
  '```',
  'Closing notes.',
].join('\n');

async function resolveWith(original: string, reply: string) {
  const m = memIO(original);
  const ok = await makeLlmConflictResolver({ run: async () => reply, io: m.io })({
    task,
    conflictFiles: ['doc.md'],
    cwd: '/repo',
  });
  return { ok, written: m.get() };
}

describe('makeLlmConflictResolver unfencing', () => {
  it('writes an unwrapped Markdown resolution verbatim, inner code fences included', async () => {
    expect(await resolveWith(MARKDOWN_CONFLICT, MARKDOWN_RESOLVED)).toEqual({
      ok: true,
      written: MARKDOWN_RESOLVED,
    });
  });

  it('still strips a fence that surrounds the whole Markdown reply', async () => {
    expect(
      await resolveWith(MARKDOWN_CONFLICT, `\n\`\`\`markdown\n${MARKDOWN_RESOLVED}\n\`\`\`\n`),
    ).toEqual({ ok: true, written: MARKDOWN_RESOLVED });
  });

  it('keeps unwrapping a fenced reply with prose around it when the file has no fences', async () => {
    const original = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> b\nkeep';
    expect(
      await resolveWith(original, 'Here is the file:\n```ts\nmerged\nkeep\n```\nDone.'),
    ).toEqual({ ok: true, written: 'merged\nkeep' });
  });
});
