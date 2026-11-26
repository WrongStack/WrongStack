import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractInterruptedTools, SessionRecovery } from '../../src/storage/session-recovery.js';

const KEY = `AKIA${'Q'.repeat(16)}`;
const REDACTED = '[REDACTED:aws_access_key]';
const ts = (minute: number) => `2026-11-26T00:${String(minute).padStart(2, '0')}:00.000Z`;

/**
 * F2383: `session-read-scrubber.ts` scrubs the persisted object graph before it
 * enters a cache, projection, search result, export or surface response. The
 * recovery readers parse the journal themselves, and the CLI renders the plan
 * (`/session --recover`: context, checkpoint preview, interrupted tool args) and
 * the stale listing's context. They must apply the same boundary.
 */
describe('recovery surfaces stay behind the read-side scrub boundary (F2383)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recovery-scrub-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function writeJournal(secretSuffix: string): Promise<void> {
    const journal = [
      { type: 'session_start', ts: ts(0), model: 'm', provider: 'p' },
      {
        type: 'checkpoint',
        ts: ts(1),
        promptIndex: 0,
        promptPreview: `deploy with ${secretSuffix}`,
        seq: 1,
      },
      {
        type: 'in_flight_start',
        ts: ts(2),
        context: `running deploy with ${secretSuffix}`,
        seq: 2,
      },
      {
        type: 'tool_call_start',
        ts: ts(3),
        name: 'bash',
        id: 'c1',
        input: { command: `export AWS_ACCESS_KEY_ID=${secretSuffix}` },
        seq: 3,
      },
    ];
    await fsp.writeFile(
      path.join(dir, 's1.jsonl'),
      `${journal.map((event) => JSON.stringify(event)).join('\n')}\n`,
    );
  }

  it('redacts the plan context, checkpoint preview and interrupted tool args', async () => {
    await writeJournal(KEY);
    const recovery = new SessionRecovery(dir);
    const plan = await recovery.recover('s1');
    expect(plan).not.toBeNull();
    if (!plan) return;

    const rendered = JSON.stringify(plan) + JSON.stringify(extractInterruptedTools(plan));
    expect(rendered).not.toContain(KEY);
    expect(plan.context).toContain(REDACTED);
  });

  it('redacts the stale-session context the listing prints', async () => {
    await writeJournal(KEY);
    const stale = await new SessionRecovery(dir).detectStale('s1');

    expect(stale).not.toBeNull();
    expect(stale?.context).not.toContain(KEY);
    expect(stale?.context).toContain(REDACTED);
  });

  it('keeps ordinary recovery content intact (control)', async () => {
    await writeJournal('not-a-secret');
    const recovery = new SessionRecovery(dir);
    const plan = await recovery.recover('s1');
    const stale = await recovery.detectStale('s1');

    expect(plan?.context).toBe('running deploy with not-a-secret');
    expect(stale?.context).toBe('running deploy with not-a-secret');
    expect(extractInterruptedTools(plan!).length).toBe(1);
  });
});
