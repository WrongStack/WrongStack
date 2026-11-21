import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { dispatchLogPath, recordDispatch, summarizeDispatchLog } from '../src/dispatch-log.js';

const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

describe('summarizeDispatchLog malformed field resilience', () => {
  it('survives non-array alternatives and non-string outcome roles/models without throwing', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dispatch-log-malformed-'));
    dirs.push(dir);
    recordDispatch(
      { at: '2026-11-21T00:00:00.000Z', role: 'reviewer', source: 'explicit-role' },
      dir,
    );
    await fs.appendFile(
      dispatchLogPath(dir),
      `${JSON.stringify({ at: '2026-11-21T00:01:00.000Z', role: 'coder', source: 'description', alternatives: 42 })}\n` +
        `${JSON.stringify({ at: '2026-11-21T00:01:30.000Z', role: 'coder', source: 'description', alternatives: 'xyz' })}\n` +
        `${JSON.stringify({ kind: 'outcome', at: '2026-11-21T00:02:00.000Z', subagentId: 's1', role: 123, status: 'success' })}\n` +
        `${JSON.stringify({ kind: 'outcome', at: '2026-11-21T00:02:30.000Z', subagentId: 's2', role: 'reviewer', status: 'success', model: { bad: true } })}\n`,
      'utf8',
    );

    const summary = summarizeDispatchLog(dir);
    expect(summary.entries).toBe(3);
    expect(summary.roles.map((r) => r.role)).toEqual(['coder', 'reviewer']);
  });
});
