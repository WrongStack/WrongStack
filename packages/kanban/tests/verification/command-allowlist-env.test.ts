/**
 * Operator-widened verifier commands: WRONGSTACK_KANBAN_VERIFIER_COMMANDS.
 *
 * Command-type acceptance checks could previously never run real build
 * tools: the default allowlist is read-only-only (pwd/true/false/test) and
 * completion-protocol constructed VerificationContext without an allowlist.
 * These tests pin the env parsing, the gate precedence, the bin-shim
 * resolution, and the completion-protocol threading end to end.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { KanbanBoard, KanbanTask } from '../../src/types.js';
import {
  buildAllowlist,
  commandAllowlistFromEnv,
  VERIFIER_COMMANDS_ENV,
} from '../../src/verification/command-security.js';
import { VerificationContext } from '../../src/verification/verification-context.js';
import { verifyTaskCompletion } from '../helpers/session-manager.js';

const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url));

const stubBoard = { id: 'b-stub', title: 'stub', columns: [], tasks: [] } as unknown as KanbanBoard;
const stubTask = { id: 't-stub', title: 'stub', status: 'pending' } as unknown as KanbanTask;

const contextWith = (
  allowlist: ConstructorParameters<typeof VerificationContext>[0]['commandAllowlist'],
) =>
  new VerificationContext({
    projectRoot: repoRoot,
    board: stubBoard,
    task: stubTask,
    commandAllowlist: allowlist,
  });

const tscShimExists =
  process.platform === 'win32'
    ? await fs
        .access(path.join(repoRoot, 'node_modules', '.bin', 'tsc.cmd'))
        .then(() => true, () => false)
    : await fs
        .access(path.join(repoRoot, 'node_modules', '.bin', 'tsc'))
        .then(() => true, () => false);
const realTscIt = tscShimExists ? it : it.skip;

describe('commandAllowlistFromEnv', () => {
  it('returns undefined when the variable is unset or blank', () => {
    expect(commandAllowlistFromEnv({})).toBeUndefined();
    expect(commandAllowlistFromEnv({ [VERIFIER_COMMANDS_ENV]: '' })).toBeUndefined();
    expect(commandAllowlistFromEnv({ [VERIFIER_COMMANDS_ENV]: '   ' })).toBeUndefined();
    expect(commandAllowlistFromEnv({ [VERIFIER_COMMANDS_ENV]: ' , , ' })).toBeUndefined();
  });

  it('parses comma-separated entries with trimming and +/- syntax', () => {
    expect(commandAllowlistFromEnv({ [VERIFIER_COMMANDS_ENV]: '+tsc' })).toEqual({
      allowedCommands: ['+tsc'],
    });
    expect(commandAllowlistFromEnv({ [VERIFIER_COMMANDS_ENV]: ' +tsc , vitest , -foo ' })).toEqual({
      allowedCommands: ['+tsc', 'vitest', '-foo'],
    });
  });

  it('never grants allowAll and the hard blocklist keeps precedence', () => {
    const { allow, block } = buildAllowlist(commandAllowlistFromEnv({
      [VERIFIER_COMMANDS_ENV]: '+tsc,+pnpm',
    }));
    expect(allow.has('tsc')).toBe(true);
    expect(allow.has('pnpm')).toBe(true);
    // …but pnpm is still hard-blocked, and validateCommand checks block first.
    expect(block.has('pnpm')).toBe(true);
  });
});

describe('VerificationContext.runCommand with a widened allowlist', () => {
  it('rejects tsc without the allowlist extension', async () => {
    const result = await contextWith(undefined).runCommand('tsc --version');
    expect(result.rejected).toBe(true);
    expect(result.stderr).toContain('not in the verifier allowlist');
  });

  realTscIt(
    'runs the real local tsc when +tsc is configured',
    { timeout: 60_000 },
    async () => {
      const allowlist = commandAllowlistFromEnv({ [VERIFIER_COMMANDS_ENV]: '+tsc' });
      const result = await contextWith(allowlist).runCommand('tsc --version');
      expect(result.rejected).toBeFalsy();
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/Version/i);
    },
  );
});

describe('completion-protocol threads the env allowlist', () => {
  const roots: string[] = [];
  afterEach(async () => {
    delete process.env[VERIFIER_COMMANDS_ENV];
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  /** A tmp project root with a fake `tsc` bin shim so no real toolchain is needed. */
  async function shimmedRoot(): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-allowlist-'));
    roots.push(root);
    await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'shim-root' }), 'utf8');
    const binDir = path.join(root, 'node_modules', '.bin');
    await fs.mkdir(binDir, { recursive: true });
    if (process.platform === 'win32') {
      await fs.writeFile(path.join(binDir, 'tsc.cmd'), '@echo tsc-shim-ok\r\n', 'utf8');
    } else {
      await fs.writeFile(path.join(binDir, 'tsc'), '#!/bin/sh\necho tsc-shim-ok\n', 'utf8');
      await fs.chmod(path.join(binDir, 'tsc'), 0o755);
    }
    return root;
  }

  it('passes a command check when the env var widens the allowlist', async () => {
    const root = await shimmedRoot();
    const { createBoard, addTask, addCheckToTask } = await import('../helpers/session-manager.js');
    const board = await createBoard(root, { title: 'Allowlist board' });
    const added = await addTask(root, board.id, { title: 'Typecheck task' });
    await addCheckToTask(root, board.id, added!.task.id, {
      description: 'tsc --version exits 0',
      type: 'command',
      status: 'pending',
      notes: 'tsc --version',
    });

    process.env[VERIFIER_COMMANDS_ENV] = '+tsc';
    const result = await verifyTaskCompletion(root, board.id, added!.task.id);
    const check = result.task.successCriteria?.[0];
    expect(check?.status).toBe('passed');
    expect(result.report.verdict).toBe('passed');
    expect(result.report.checks[0]?.evidence['stdout'] ?? '').toContain('tsc-shim-ok');
  });

  it('still rejects the same command without the env var', async () => {
    const root = await shimmedRoot();
    const { createBoard, addTask, addCheckToTask } = await import('../helpers/session-manager.js');
    const board = await createBoard(root, { title: 'Deny board' });
    const added = await addTask(root, board.id, { title: 'Denied task' });
    await addCheckToTask(root, board.id, added!.task.id, {
      description: 'tsc --version exits 0',
      type: 'command',
      status: 'pending',
      notes: 'tsc --version',
    });

    delete process.env[VERIFIER_COMMANDS_ENV];
    const result = await verifyTaskCompletion(root, board.id, added!.task.id);
    const check = result.task.successCriteria?.[0];
    // A security-gate rejection is an error, not a test failure: the check
    // lands as failed but the report verdict escalates to needs_human.
    expect(check?.status).toBe('failed');
    expect(result.report.verdict).toBe('needs_human');
    expect(String(result.report.checks[0]?.evidence['rejectionReason'] ?? '')).toContain(
      'not in the verifier allowlist',
    );
  });
});
