import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { AgentFactory } from '@wrongstack/coordination';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  createCodeAssistRouteHandlers,
  handleCodeAssistRoute,
} from '../src/server/code-assist-routes.js';
import type { WSClientMessage } from '../src/server/types.js';

let dir = '';
const base = resolve(tmpdir());
beforeEach(async () => {
  dir = await mkdtemp(join(base, 'code-assist-capture-'));
  await mkdir(join(dir, 'src'));
  await writeFile(join(dir, 'src', 'a.ts'), 'old a');
});
afterEach(async () => {
  expect(dir.startsWith(base + sep)).toBe(true);
  await rm(dir, { recursive: true, force: true });
});

/** A worker that announces each tool the way the executor does, then performs it. */
function harness(
  steps: Array<{ name: string; input: Record<string, unknown>; act?: () => Promise<void> }>,
) {
  const events = new EventBus();
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const factory = (async () => ({
    agent: {
      run: async () => {
        for (const step of steps) {
          events.emit('tool.started', {
            name: step.name,
            id: step.name,
            input: step.input,
          } as never);
          await step.act?.();
        }
        return { status: 'done', finalText: 'done' };
      },
    },
    events,
    dispose: async () => {},
  })) as unknown as AgentFactory;
  const handlers = createCodeAssistRouteHandlers({
    subagentFactory: factory,
    projectRoot: () => dir,
    send: (_ws, msg) => sent.push(msg as (typeof sent)[number]),
  });
  return async (payload: Record<string, unknown>) => {
    await handleCodeAssistRoute(
      { readyState: 1, send: () => {} } as unknown as WebSocket,
      { type: 'code.assist.run', payload } as unknown as WSClientMessage,
      handlers,
    );
    return sent.find((message) => message.type === 'code.assist.result')!.payload;
  };
}

it('reports each file an editing run wrote with its content from before the first write', async () => {
  const run = harness([
    {
      name: 'edit',
      input: { path: 'src/a.ts' },
      act: () => writeFile(join(dir, 'src', 'a.ts'), 'new a'),
    },
    // A second write to the same file keeps the first before-content.
    {
      name: 'write',
      input: { path: 'src/a.ts' },
      act: () => writeFile(join(dir, 'src', 'a.ts'), 'newer a'),
    },
    {
      name: 'write',
      input: { path: join(dir, 'created.ts') },
      act: () => writeFile(join(dir, 'created.ts'), 'made'),
    },
    { name: 'write', input: { path: '../outside.ts' } },
    { name: 'bash', input: { command: 'sed -i s/x/y/ src/a.ts' } },
    { name: 'read', input: { path: 'src/a.ts' } },
  ]);
  const result = await run({ requestId: 'r1', filePath: 'src/a.ts', preset: 'fix' });
  expect(result).toMatchObject({ status: 'done', appliedEdits: true });
  expect(result['edits']).toEqual([
    { path: 'src/a.ts', before: 'old a' },
    { path: 'created.ts', before: null },
  ]);
  expect(result['uncaptured']).toEqual(['../outside.ts (write)', 'bash']);
});

it('captures nothing on a read-only run', async () => {
  const run = harness([{ name: 'edit', input: { path: 'src/a.ts' } }]);
  const result = await run({ requestId: 'r2', filePath: 'src/a.ts', preset: 'bugs' });
  expect(result).not.toHaveProperty('edits');
});
