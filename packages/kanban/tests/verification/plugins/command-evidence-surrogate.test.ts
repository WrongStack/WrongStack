import { describe, expect, it } from 'vitest';
import type { KanbanCheck, KanbanTask } from '../../../src/types.js';
import { CommandPlugin } from '../../../src/verification/plugins/command.js';
import type { VerificationContext } from '../../../src/verification/verification-context.js';

const EMOJI = String.fromCodePoint(0x1f600);

function commandCheck(): KanbanCheck {
  return { id: 'cmd', description: 'pwd', type: 'command', status: 'pending' } as KanbanCheck;
}

function contextReturning(output: { exitCode: number; stdout: string; stderr: string }) {
  return {
    projectRoot: '/fake',
    board: {} as never,
    task: {} as KanbanTask,
    requireBackingEvidence: false,
    runCommand: async (command: string) => ({ command, durationMs: 1, ...output }),
  } as unknown as VerificationContext;
}

/**
 * F1482: command output is cut before it is stored as check evidence, and
 * verifyTaskCompletion persists that evidence in the task's verificationReport.
 * A raw slice ending between the halves of a surrogate pair stored a lone
 * surrogate there.
 */
describe('CommandPlugin evidence cut (F1482)', () => {
  const plugin = new CommandPlugin();

  it('never ends stdout or stderr evidence with a lone surrogate', async () => {
    const result = await plugin.verify(
      commandCheck(),
      contextReturning({
        exitCode: 0,
        stdout: `${'a'.repeat(4999)}${EMOJI} rest`,
        stderr: `${'e'.repeat(1999)}${EMOJI} rest`,
      }),
    );
    expect(result.evidence.stdout).toBe('a'.repeat(4999));
    expect(result.evidence.stderr).toBe('e'.repeat(1999));
  });

  it('never ends the failure message with a lone surrogate', async () => {
    const result = await plugin.verify(
      commandCheck(),
      contextReturning({ exitCode: 2, stdout: '', stderr: `${'e'.repeat(499)}${EMOJI} rest` }),
    );
    expect(result.error).toBe(`Command exited with code 2: ${'e'.repeat(499)}`);
    expect(result.error?.isWellFormed()).toBe(true);
  });

  it('keeps a pair that ends exactly at the limit and cuts plain text at the limit', async () => {
    const result = await plugin.verify(
      commandCheck(),
      contextReturning({
        exitCode: 0,
        stdout: `${'a'.repeat(4998)}${EMOJI}tail`,
        stderr: `${'e'.repeat(2000)}tail`,
      }),
    );
    expect(result.evidence.stdout).toBe(`${'a'.repeat(4998)}${EMOJI}`);
    expect(result.evidence.stderr).toBe('e'.repeat(2000));
  });
});
