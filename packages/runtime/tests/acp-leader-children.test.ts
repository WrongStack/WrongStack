import { fileURLToPath } from 'node:url';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, Tool } from '@wrongstack/contracts/types';
import { expect, it } from 'vitest';
import { bindAcpLeaderHost } from '../src/acp-leader/acp-leader-host.js';
import { AcpLeaderProvider } from '../src/acp-leader/acp-leader-provider.js';
import { buildAcpCommand } from '../src/portable-commands/acp.js';

it('shows native child sessions and labels a child approval without mixing the parent output', async () => {
  const model = 'fixture-children';
  const sessionId = 'tab-for-children';
  const projectRoot = process.cwd();
  const config = {
    model,
    acp: {
      agents: {
        [model]: {
          command: process.execPath,
          args: [
            fileURLToPath(new URL('./fixtures/acp-session-peer.ts', import.meta.url)),
            'children',
          ],
        },
      },
      bridge: { agents: [], servers: [] },
    },
  } as Config;
  const events = new EventBus();
  bindAcpLeaderHost({
    events,
    projectRoot,
    getConfig: () => config,
    confirmThroughEvents: true,
    permission: () => ({ evaluate: async () => ({ permission: 'confirm' }) }) as never,
    context: () => ({ meta: {} }) as never,
    getTool: (name) => ({ name }) as Tool,
    runTool: async () => ({ content: '', isError: true }),
  });
  const provider = new AcpLeaderProvider({ bootConfig: config, buildProvider: () => undefined });
  const command = buildAcpCommand({
    renderer: { write: () => {}, writeInfo: () => {}, writeWarning: () => {} },
    projectRoot,
    cwd: projectRoot,
    configStore: { get: () => config } as never,
  });
  const ctx = { provider, model, session: { id: sessionId }, meta: {} } as never;
  const confirm: Array<{ sessionId?: string | undefined; label?: string | undefined }> = [];
  events.on('tool.confirm_needed', (event) => {
    confirm.push({ sessionId: event.sessionId, label: event.boundaryReason });
    event.resolve('no');
  });
  try {
    const output: string[] = [];
    for await (const event of provider.stream(
      {
        model,
        cache: { sessionId, threadId: sessionId },
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Review' }] }],
      } as never,
      { signal: AbortSignal.timeout(15_000) },
    )) {
      if (event.type === 'text_delta') output.push(event.text);
    }
    expect(output.join('')).toBe('Parent response');
    expect(confirm).toEqual([{ sessionId, label: 'ACP subagent Reviewer' }]);
    await expect
      .poll(async () => (await command.run('children', ctx))?.message)
      .toContain('Reviewer "review-child" — idle (cancelled)\n  Reader "nested-child"');
    const detail = (await command.run('children review-child', ctx))?.message;
    expect(detail).toContain('Child response');
    expect(detail).toContain('Message from "fresh-session"\nLook over the proposed changes.');
    expect((await command.run('children unrelated', ctx))?.message).toContain(
      'no ACP child session',
    );
  } finally {
    await provider.closeAll();
    bindAcpLeaderHost(undefined);
  }
});
