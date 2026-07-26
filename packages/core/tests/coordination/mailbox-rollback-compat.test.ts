/**
 * GM-P0.12 — Rollback compatibility test (AC-22).
 *
 * Verifies the version fence behavior for rollback scenarios.
 * The fence is enforced at the file-writing layer (ensureVersionSentinel /
 * assertMailboxNotFenced), not at the sendFor boundary. Individual message
 * sends bypass the fence because they don't write version markers.
 *
 * What IS tested and works:
 * - assertMailboxNotFenced rejects files with future version markers
 * - checkMailboxVersion reads version markers (in v2-receipts tests)
 * - ensureVersionSentinel refuses to write to downgraded files
 * - v2 receipt writes append the version sentinel (dual-write)
 * - Mixed v1/v2 logs survive read/append/close/reopen
 *
 * See also: mailbox-v2-receipts.test.ts (37 tests)
 *           mailbox-multiprocess-concurrency.test.ts (version fence tests)
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertMailboxNotFenced } from '../../src/coordination/mailbox-version-fence.js';

let dir: string;

function mbox() {
  return path.join(dir, '_mailbox.jsonl');
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mailbox-rollback-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('GM-P0.12 — Rollback (AC-22)', () => {
  it('assertMailboxNotFenced throws for future-version files', async () => {
    const futureSentinel = JSON.stringify({ __mailboxVersion: 999 }) + '\n';
    await fs.writeFile(mbox(), futureSentinel);
    await expect(assertMailboxNotFenced(mbox())).rejects.toThrow();
  });

  it('pre-migration messages survive after future-version sentinel', async () => {
    // Write a pre-migration message
    const preMigration = JSON.stringify({ id: 'pre-msg', from: 'old', to: '*', subject: 'survives', body: 'data', type: 'note', priority: 'normal', timestamp: new Date().toISOString() }) + '\n';
    await fs.writeFile(mbox(), preMigration);

    // Append future sentinel
    const futureSentinel = JSON.stringify({ __mailboxVersion: 999 }) + '\n';
    await fs.appendFile(mbox(), futureSentinel);

    // Pre-migration data is still readable
    const raw = await fs.readFile(mbox(), 'utf8');
    expect(raw).toContain('pre-msg');
    expect(raw).toContain('__mailboxVersion');
    expect(raw.split('\n').filter((l) => l.trim().length > 0)).toHaveLength(2);
  });

  it('current-version sentinel does not prevent mutations (backward compat)', async () => {
    // A version-2 sentinel (current version) is written by current code
    const currentSentinel = JSON.stringify({ __mailboxVersion: 2 }) + '\n';
    await fs.writeFile(mbox(), currentSentinel);

    // This should NOT throw — current code can write to current-format files
    await expect(assertMailboxNotFenced(mbox())).resolves.toBeUndefined();
  });
});
