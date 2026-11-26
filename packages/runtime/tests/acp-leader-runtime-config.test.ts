import { fileURLToPath } from 'node:url';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, SessionEvent } from '@wrongstack/contracts/types';
import { resetSessionSubagentModelPlan } from '@wrongstack/coordination';
import { expect, it } from 'vitest';
import { bindAcpLeaderHost } from '../src/acp-leader/acp-leader-host.js';
import { AcpLeaderProvider } from '../src/acp-leader/acp-leader-provider.js';
import { buildAcpCommand } from '../src/portable-commands/acp.js';

it('reads, changes and resets the ACP leader configuration in the current conversation', async () => {
  const model = 'fixture-runtime-config';
  const sessionId = 'acp-leader-runtime-config';
  const projectRoot = process.cwd();
  const config = {
    model,
    acp: {
      agents: {
        [model]: {
          command: process.execPath,
          args: [
            fileURLToPath(
              new URL('../../acp/tests/fixtures/runtime-config-agent.ts', import.meta.url),
            ),
          ],
        },
      },
      bridge: { servers: [] },
    },
  } as unknown as Config;
  const meta: Record<string, unknown> = {};
  const journal: SessionEvent[] = [];
  let rejectJournalWrite = false;
  bindAcpLeaderHost({
    events: new EventBus(),
    projectRoot,
    getConfig: () => config,
    permission: () => ({ evaluate: async () => ({ permission: 'auto' }) }) as never,
    context: () => ({ meta }) as never,
    getTool: () => undefined,
    runTool: async () => ({ content: '', isError: false }),
  });
  const provider = new AcpLeaderProvider({ bootConfig: config, buildProvider: () => undefined });
  const ctx = {
    provider,
    model,
    meta,
    session: {
      id: sessionId,
      append: async (event: SessionEvent) => {
        if (rejectJournalWrite) throw new Error('Journal unavailable');
        journal.push(event);
      },
    },
  } as never;
  const command = buildAcpCommand({
    renderer: { write: () => {}, writeInfo: () => {}, writeWarning: () => {} },
    projectRoot,
    cwd: projectRoot,
    configStore: { get: () => config } as never,
  });
  const settings = async (args = '') =>
    (await command.run(`config ${model} ${args}`, ctx))?.message;
  async function ask(text: string): Promise<string> {
    const output: string[] = [];
    for await (const event of provider.stream(
      {
        model,
        cache: { sessionId, threadId: sessionId },
        messages: [{ role: 'user', content: [{ type: 'text', text }] }],
      } as never,
      { signal: AbortSignal.timeout(15_000) },
    )) {
      if (event.type === 'text_delta') output.push(event.text);
    }
    return output.join('');
  }
  try {
    expect(await ask('Adjust your effort')).toBe('fast/medium');
    expect((await command.run('config', ctx))?.message).toContain('thought: medium');
    expect(journal).toHaveLength(0);

    rejectJournalWrite = true;
    expect(await settings('engine deep')).toContain('Journal unavailable');
    rejectJournalWrite = false;
    expect(await settings()).toContain('thought: medium');
    expect(journal).toHaveLength(0);

    const [modelChange, effortChange] = await Promise.all([
      settings('engine deep'),
      settings('thought ultra'),
    ]);
    expect(modelChange).toContain('thought: high\n  high | ultra');
    expect(effortChange).toContain('thought: ultra');
    expect(await settings('thought low')).toContain('does not offer "low"');
    rejectJournalWrite = true;
    expect(await settings('reset')).toContain('Journal unavailable');
    rejectJournalWrite = false;
    expect(await settings()).toContain('thought: ultra');
    expect(journal).toHaveLength(2);
    expect(await ask('Report configuration')).toBe('deep/ultra');

    expect(await settings('reset')).toContain('thought: medium');
    expect(await ask('Report configuration')).toBe('fast/medium');
    expect(journal.at(-1)).toMatchObject({
      type: 'acp_runtime_settings',
      settings: { [model]: {} },
    });
  } finally {
    resetSessionSubagentModelPlan(sessionId);
    await provider.closeAll();
    bindAcpLeaderHost(undefined);
  }
});
