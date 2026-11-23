import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { _filePermOps } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import plugin from '../src/decision-journal/index.js';

/**
 * F45 (WS-045 class): decision_record appends architectural decisions and
 * rationales (project content) to a project JSONL journal via appendFile +
 * mode 0o600 (a Windows no-op) with no owner-only hardening. On Windows the
 * journal stayed readable by other local accounts where inheritance was not
 * owner-only. Each journal path is hardened once (best-effort).
 *
 * Deterministic call-site proof: inject the win32 seam (_filePermOps), capture
 * icacls for the journal path; the plugin's real setup/execute harness.
 */
const icaclsCalls: Array<{ file: string; args: readonly string[] }> = [];
let dir: string;
let recordTool: {
  execute: (input: Record<string, unknown>, ctx: Record<string, unknown>) => Promise<unknown>;
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-f45-'));
  icaclsCalls.length = 0;
  _filePermOps.platform = 'win32';
  _filePermOps.userInfo = (() => ({
    username: 'tester',
    uid: -1,
    gid: -1,
    homedir: 'C:\\Users\\tester',
    shell: null,
  })) as typeof _filePermOps.userInfo;
  _filePermOps.execFileAsync = async (file, args) => {
    icaclsCalls.push({ file, args });
    return { stdout: '', stderr: '' };
  };
  await plugin.setup({
    config: { extensions: {} },
    tools: {
      register: (tool: { name: string }) => {
        if (tool.name === 'decision_record') recordTool = tool as never;
      },
    },
  } as never);
});

afterEach(async () => {
  _filePermOps.platform = process.platform;
  _filePermOps.userInfo = undefined;
  _filePermOps.execFileAsync = undefined;
  await fs.rm(dir, { recursive: true, force: true });
});

const hardened = (t: string) => icaclsCalls.some((c) => c.file === 'icacls' && c.args[0] === t);
const record = (title: string) =>
  recordTool.execute(
    { journal: 'journal.jsonl', title, rationale: 'because', files: ['src/a.ts'] },
    { cwd: dir, workspaceRoot: dir },
  );

describe('decision journal owner-only hardening (F45)', () => {
  it('hardens the journal on decision_record', async () => {
    await record('first decision');
    expect(
      hardened(path.join(dir, 'journal.jsonl')),
      'decision_record issues icacls for the journal',
    ).toBe(true);
  });

  it('hardens ONCE across multiple records', async () => {
    await record('first');
    await record('second');
    const count = icaclsCalls.filter(
      (c) => c.file === 'icacls' && c.args[0] === path.join(dir, 'journal.jsonl'),
    ).length;
    expect(count).toBe(1);
  });
});
