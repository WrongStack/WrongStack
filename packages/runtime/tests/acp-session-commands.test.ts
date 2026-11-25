import { fileURLToPath } from 'node:url';
import { runOneAcpTask } from '@wrongstack/acp';
import { expect, it } from 'vitest';
import { listAcpSessions } from '../src/portable-commands/acp-sessions.js';

const fixturePath = fileURLToPath(new URL('./fixtures/acp-session-peer.ts', import.meta.url));
const root = process.cwd();
const fixture = { command: process.execPath, args: [fixturePath] };

it('lists one page of external ACP sessions for this project and preserves the cursor', async () => {
  const input = { agentId: 'fixture', projectRoot: root, overrides: { fixture } };
  const first = await listAcpSessions(input);
  expect(first).toEqual({
    sessions: [{ sessionId: 'original-session', cwd: root, title: 'Existing thread' }],
    nextCursor: 'page-2==',
  });
  const second = await listAcpSessions({ ...input, cursor: first.nextCursor });
  expect(second).toEqual({
    sessions: [{ sessionId: 'original-session', cwd: root, title: 'page-2==' }],
  });
});

it.each([
  ['resume', [], 'original-session'],
  ['resume', ['load-only'], 'original-session'],
  ['fork', [], 'forked-session'],
] as const)('sends the prompt to the selected %s session', async (action, args, expected) => {
  const result = await runOneAcpTask({
    ...fixture,
    args: [...fixture.args, ...args],
    cwd: root,
    projectRoot: root,
    timeoutMs: 2_000,
    task: 'Continue',
    sessionTarget: { action, sessionId: 'original-session' },
  });
  expect(result).toMatchObject({ result: `Task reached ${expected}`, agentSessionId: expected });
});

it('fails if the agent rejects the requested session', async () => {
  await expect(
    runOneAcpTask({
      ...fixture,
      cwd: root,
      projectRoot: root,
      timeoutMs: 2_000,
      task: 'Continue',
      sessionTarget: { action: 'resume', sessionId: 'missing-session' },
    }),
  ).rejects.toMatchObject({ message: expect.stringContaining('Session not found') });
});
