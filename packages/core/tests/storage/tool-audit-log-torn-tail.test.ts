import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolAuditLog } from '../../src/storage/tool-audit-log.js';

/**
 * A crash mid-append leaves a newline-less fragment at the tail of the audit
 * file. The next record() appended straight onto it, so its JSON was glued to
 * the fragment on one unparseable line: readAll skipped the line and the new
 * entry vanished from the chain while verify() still reported ok.
 */

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-audit-torn-'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function entry(sessionId: string, toolUseId: string) {
  return {
    sessionId,
    toolName: 'bash',
    toolUseId,
    input: { command: 'echo hi' },
    output: { stdout: 'hi' },
    isError: false,
  };
}

describe('ToolAuditLog after a torn final line', () => {
  it('control: a clean tail keeps every entry', async () => {
    await new ToolAuditLog({ dir }).record(entry('sess_A', 'tu1'));
    const next = new ToolAuditLog({ dir });
    await next.record(entry('sess_A', 'tu2'));
    expect(await next.verify('sess_A')).toEqual({ ok: true, entries: 2 });
  });

  it('starts the next entry on its own line', async () => {
    await new ToolAuditLog({ dir }).record(entry('sess_A', 'tu1'));
    await fs.appendFile(path.join(dir, 'sess_A.audit.jsonl'), '{"index":1,"toolNa', 'utf8');

    const next = new ToolAuditLog({ dir });
    await next.record(entry('sess_A', 'tu2'));

    expect(await next.verify('sess_A')).toEqual({ ok: true, entries: 2 });
  });
});
