import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { SessionSummary } from '@wrongstack/contracts/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { selectPickerSessions } from '../src/boot/tui-session-stub-enrich.js';

let dir: string;

beforeAll(async () => {
  const root = path.resolve('.temp_files/resume-whitespace/round-86bfb349');
  await fs.mkdir(root, { recursive: true });
  dir = await fs.mkdtemp(path.join(root, 'sessions-'));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('resume picker transcript whitespace', () => {
  it.each([
    ['plain', 'Fix the picker', 'Fix the picker'],
    ['newline', 'Fix\nthe picker', 'Fix the picker'],
    ['tab', 'Fix\tthe picker', 'Fix the picker'],
    ['crlf', 'Fix\r\nthe picker', 'Fix the picker'],
    ['controls', '\u001b[31mFix\u001b[0m\u0000\u0007 the picker', 'Fix the picker'],
  ])('preserves word boundaries in %s titles and previews', async (id, content, expected) => {
    const summary: SessionSummary = {
      id,
      title: '',
      startedAt: '2026-11-09T12:00:00.000Z',
      model: 'fixture',
      provider: 'fixture',
      tokenTotal: 0,
    };
    await fs.writeFile(
      path.join(dir, `${id}.jsonl`),
      `${JSON.stringify({ type: 'user_input', ts: summary.startedAt, content })}\n`,
    );
    const selected = await selectPickerSessions(async () => [summary], dir, 1);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.title).toBe(expected);
    expect(selected[0]?.lastUserMessage).toBe(expected);
  });
});
