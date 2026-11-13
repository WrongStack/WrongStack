import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ArchitectureDecisionStore } from '@wrongstack/core/storage';
import { afterEach, expect, it, vi } from 'vitest';
import { buildAdrCommand } from '../../runtime/src/portable-commands/adr.js';
import { handleCommandRoute } from '../src/server/command-routes.js';

let dir: string;
afterEach(() => {
  vi.unstubAllEnvs();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

it('reviews ADRs through the user command route and correlates stale failures to their request', async () => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'adr-ws-route-'));
  vi.stubEnv('WRONGSTACK_HOME', path.join(dir, 'home'));
  const projectRoot = path.join(dir, 'project');
  const store = new ArchitectureDecisionStore(projectRoot);
  const pending = store.propose(
    {
      title: 'Project boundary',
      context: 'Shared runtime.',
      decision: 'Keep state project scoped.',
      alternatives: [],
      consequences: [],
      constraints: [],
      scope: [],
      revisitWhen: '',
    },
    'worker',
  );
  const messages: unknown[] = [];
  const ctx = {
    getCommands: () => [buildAdrCommand({ projectRoot })],
    send: (_ws: unknown, message: unknown) => messages.push(message),
  };
  const request = {
    type: 'command.run',
    payload: {
      name: 'adr',
      args: `accept ${pending.id} ${pending.revision} ${pending.contentHash} Reviewed project isolation`,
      requestId: 'review-1',
    },
  };
  expect(await handleCommandRoute(ctx, {} as never, request as never)).toBe(true);
  expect(messages[0]).toMatchObject({
    type: 'command.result',
    payload: {
      requestId: 'review-1',
      name: 'adr',
      message: expect.stringContaining('Status: accepted'),
    },
  });
  expect(store.get(pending.id)?.status).toBe('accepted');
  await handleCommandRoute(
    ctx,
    {} as never,
    { ...request, payload: { ...request.payload, requestId: 'review-2' } } as never,
  );
  expect(messages[1]).toMatchObject({
    type: 'command.result',
    payload: { requestId: 'review-2', error: expect.stringContaining('changed since review') },
  });
});
