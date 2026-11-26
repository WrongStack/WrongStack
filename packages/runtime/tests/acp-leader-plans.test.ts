import { fileURLToPath } from 'node:url';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Config } from '@wrongstack/contracts/types';
import { type Context, ConversationState } from '@wrongstack/core/agent';
import { expect, it } from 'vitest';
import { bindAcpLeaderHost } from '../src/acp-leader/acp-leader-host.js';
import { AcpLeaderProvider } from '../src/acp-leader/acp-leader-provider.js';
import { buildAcpCommand } from '../src/portable-commands/acp.js';

it('shows ACP checklists and Markdown separately while updating the conversation worklist', async () => {
  const model = 'fixture-plans';
  const sessionId = 'tab-for-plans';
  const projectRoot = process.cwd();
  const config = {
    model,
    acp: {
      agents: {
        [model]: {
          command: process.execPath,
          args: [
            fileURLToPath(new URL('./fixtures/acp-session-peer.ts', import.meta.url)),
            'plans',
          ],
        },
      },
      bridge: { agents: [], servers: [] },
    },
  } as unknown as Config;
  const manual = { id: 'manual', content: 'Keep the local work item', status: 'pending' as const };
  const ctx = {
    model,
    meta: {},
    session: { id: sessionId },
    todos: [manual],
  } as unknown as Context;
  Object.assign(ctx, { state: new ConversationState(ctx) });
  const events = new EventBus();
  bindAcpLeaderHost({
    events,
    projectRoot,
    getConfig: () => config,
    permission: () => ({ evaluate: async () => ({ permission: 'deny' }) }) as never,
    context: () => ctx,
    getTool: () => undefined,
    runTool: async () => ({ content: '', isError: true }),
  });
  const provider = new AcpLeaderProvider({ bootConfig: config, buildProvider: () => undefined });
  ctx.provider = provider;
  const command = buildAcpCommand({
    renderer: { write: () => {}, writeInfo: () => {}, writeWarning: () => {} },
    projectRoot,
    cwd: projectRoot,
    configStore: { get: () => config } as never,
  });
  const snapshots: string[][] = [];
  const revisions: number[] = [];
  events.on('provider.todos_updated', (event) => {
    expect(event.sessionId).toBe(sessionId);
    snapshots.push(event.todos.map((item) => item.status));
    revisions.push(event.revision);
  });
  async function ask(text: string): Promise<void> {
    for await (const _ of provider.stream(
      {
        model,
        cache: { sessionId, threadId: sessionId },
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      } as never,
      { signal: AbortSignal.timeout(15_000) },
    )) {
      // Consume the turn so the fixture can finish streaming updates.
    }
  }
  try {
    expect((await command.run('plan', ctx))?.message).toContain('no active plan');
    await ask('Make a plan');
    expect((await command.run('plan', ctx))?.message).toContain(
      'In progress: Read workspace structure',
    );
    expect((await command.run('plan', ctx))?.message).toContain('# Approach\nCompare the results.');
    expect(snapshots).toEqual([
      ['pending', 'pending'],
      ['pending', 'in_progress'],
    ]);

    await ask('Drop the checklist');
    expect((await command.run('plan', ctx))?.message).not.toContain('Read workspace structure');
    expect((await command.run('plan', ctx))?.message).toContain('# Approach');
    expect(ctx.todos).toEqual([manual]);
    expect(snapshots.at(-1)).toEqual(['pending']);
    expect(revisions).toEqual([1, 2, 3]);
  } finally {
    await provider.closeAll();
    bindAcpLeaderHost(undefined);
  }
});
