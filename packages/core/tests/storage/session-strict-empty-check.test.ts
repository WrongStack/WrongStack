import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isStrictlyEmptySessionFile } from '../../src/storage/session-store/strict-empty-check.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-strict-empty-'));
  file = path.join(dir, 'session.jsonl');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function writeLines(lines: unknown[]): Promise<void> {
  await fs.writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
}

describe('isStrictlyEmptySessionFile', () => {
  it('accepts a lifecycle-only journal', async () => {
    await writeLines([
      {
        type: 'session_start',
        ts: '2026-01-01T00:00:00.000Z',
        id: 'session',
        model: 'm',
        provider: 'p',
      },
      { type: 'session_end', ts: '2026-01-01T00:01:00.000Z' },
    ]);

    await expect(isStrictlyEmptySessionFile(file)).resolves.toBe(true);
  });

  it('rejects a journal containing session content', async () => {
    await writeLines([
      {
        type: 'session_start',
        ts: '2026-01-01T00:00:00.000Z',
        id: 'session',
        model: 'm',
        provider: 'p',
      },
      { type: 'user_input', ts: '2026-01-01T00:00:01.000Z', content: 'hello' },
    ]);

    await expect(isStrictlyEmptySessionFile(file)).resolves.toBe(false);
  });

  it('fails closed for malformed or unknown events', async () => {
    await fs.writeFile(
      file,
      `${JSON.stringify({ type: 'session_start', ts: '2026-01-01T00:00:00.000Z' })}\nnot-json\n`,
    );
    await expect(isStrictlyEmptySessionFile(file)).resolves.toBe(false);

    await writeLines([
      { type: 'session_start', ts: '2026-01-01T00:00:00.000Z' },
      { type: 'future_event', ts: '2026-01-01T00:00:01.000Z' },
    ]);
    await expect(isStrictlyEmptySessionFile(file)).resolves.toBe(false);
  });

  it('rejects an empty file or a missing file', async () => {
    await fs.writeFile(file, '');
    await expect(isStrictlyEmptySessionFile(file)).resolves.toBe(false);
    await expect(isStrictlyEmptySessionFile(path.join(dir, 'missing.jsonl'))).resolves.toBe(false);
  });
});
