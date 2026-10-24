import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Tool } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Context } from '../../src/core/context.js';
import { WIDE_SUBAGENT_CAPABILITIES } from '../../src/security/capabilities.js';
import {
  classifyShellSurfaceInput,
  MAX_COMMAND_SCAN_NODES,
  shellCommandLinesFromInput,
} from '../../src/security/permission-helpers.js';
import {
  AutoApprovePermissionPolicy,
  DefaultPermissionPolicy,
} from '../../src/security/permission-policy.js';

/**
 * WS-2026-09-26-03 (security-check 2026-09-26).
 *
 * The workflow plugins register mutating tools with `shell.arbitrary` — a
 * shell surface — whose command is a `{ program, args }` object, at the top
 * (`workspace_recipe_run.command`) or nested (`acceptance_verify.criteria[].
 * command`, `dependency_upgrade_try.checks[]`). The YOLO classifier read only a
 * top-level STRING `command`, found nothing, and YOLO auto-approved — the
 * locked `agent-state` kind included. These pin the shapes those tools run.
 */

function workflowTool(name: string): Tool {
  return {
    name,
    description: name,
    inputSchema: { type: 'object' },
    permission: 'confirm',
    mutating: true,
    riskTier: 'standard',
    capabilities: ['shell.arbitrary'],
    async execute() {
      return 'ok';
    },
  } as Tool;
}

const ctx = (): Context => ({ hasRead: () => false, projectRoot: '/proj' }) as never as Context;

let dir: string;
let trustFile: string;
let fakeHome: string;
let prevHome: string | undefined;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-structured-cmd-'));
  trustFile = path.join(dir, 'trust.json');
  fakeHome = path.join(dir, 'dot-wrongstack');
  prevHome = process.env['WRONGSTACK_HOME'];
  process.env['WRONGSTACK_HOME'] = fakeHome;
});
afterEach(async () => {
  if (prevHome === undefined) delete process.env['WRONGSTACK_HOME'];
  else process.env['WRONGSTACK_HOME'] = prevHome;
  await fs.rm(dir, { recursive: true, force: true });
});

describe('shellCommandLinesFromInput', () => {
  it('reads top-level strings, top-level objects and nested objects', () => {
    expect(
      shellCommandLinesFromInput({
        command: { program: 'rm', args: ['-rf', 'my dir'] },
        criteria: [{ id: 'a', command: { program: 'git', args: ['push', '--force'] } }],
        checks: [{ program: 'pnpm', args: ['test'] }],
      }),
    ).toEqual({
      lines: ['rm -rf "my dir"', 'git push --force', 'pnpm test'],
      truncated: false,
    });
    expect(shellCommandLinesFromInput({ command: 'ls', args: ['-la'] }).lines).toEqual(['ls -la']);
  });

  it('marks a walk that hit its bounds as truncated, and classifies it as unknowable', () => {
    const padded = {
      files: Array.from({ length: MAX_COMMAND_SCAN_NODES + 10 }, () => ({})),
      checks: [{ program: 'pnpm', args: ['test'] }],
    };
    expect(shellCommandLinesFromInput(padded).truncated).toBe(true);
    expect(classifyShellSurfaceInput(padded, '/proj')).toBe('download-and-run');
  });
});

describe('YOLO classifies structured workflow commands (leader)', () => {
  const evaluate = (name: string, input: unknown) =>
    new DefaultPermissionPolicy({ trustFile, yolo: true }).evaluate(
      workflowTool(name),
      input,
      ctx(),
    );

  it('holds a top-level { program, args } that writes agent state (locked kind)', async () => {
    const decision = await evaluate('workspace_recipe_run', {
      command: { program: 'cp', args: ['evil.json', path.join(fakeHome, 'config.json')] },
    });
    expect(decision.permission).toBe('confirm');
    expect(decision.reason).toContain('agent-state');
  });

  it('holds a nested criteria[].command that deletes outside the project', async () => {
    const decision = await evaluate('acceptance_verify', {
      criteria: [
        { id: 'ok', command: { program: 'pnpm', args: ['test'] } },
        { id: 'bad', command: { program: 'rm', args: ['-rf', '/'] } },
      ],
    });
    expect(decision.permission).toBe('confirm');
  });

  it('holds a checks[] entry that force-pushes', async () => {
    const decision = await evaluate('dependency_upgrade_try', {
      files: ['package.json'],
      dependency: 'x',
      version: '1.0.0',
      checks: [{ program: 'git', args: ['push', '--force', 'origin', 'main'] }],
    });
    expect(decision.permission).toBe('confirm');
  });

  // Held by two fail-closed walks: the credential-bind carrier scan has the
  // tighter bounds (500 nodes, depth 6) and trips first, so the reason names
  // it. The command walk's own fail-closed is pinned by the unit test above.
  it('holds a command hidden behind a padded field that exhausts the walk', async () => {
    const decision = await evaluate('dependency_upgrade_try', {
      files: Array.from({ length: MAX_COMMAND_SCAN_NODES + 10 }, () => ({})),
      checks: [{ program: 'rm', args: ['-rf', '/'] }],
    });
    expect(decision.permission).toBe('confirm');
  });

  it('still auto-approves an ordinary structured command under YOLO', async () => {
    const decision = await evaluate('workspace_recipe_run', {
      command: { program: 'pnpm', args: ['test'] },
    });
    expect(decision.permission).toBe('auto');
  });
});

describe('subagent policy reads the same shapes', () => {
  it('denies a structured destructive command even with shell.arbitrary granted', async () => {
    const p = new AutoApprovePermissionPolicy(WIDE_SUBAGENT_CAPABILITIES);
    const d = await p.evaluate(workflowTool('workspace_recipe_run'), {
      command: { program: 'rm', args: ['-rf', '/'] },
    });
    expect(d.permission).toBe('deny');
    expect(d.reason).toContain('delete-outside');
  });
});
