import { fileURLToPath } from 'node:url';
import { EventBus } from '@wrongstack/contracts/kernel';
import type { Config } from '@wrongstack/contracts/types';
import { expect, it } from 'vitest';
import { bindAcpLeaderHost } from '../src/acp-leader/acp-leader-host.js';
import { AcpLeaderProvider } from '../src/acp-leader/acp-leader-provider.js';
import { buildAcpCommand } from '../src/portable-commands/acp.js';

it.each(['modern', 'legacy'])(
  'switches permission-controlled %s modes in the active ACP conversation',
  async (protocol) => {
    const model = 'claude-code';
    const sessionId = 'active-acp-mode';
    const config = {
      model,
      acp: {
        agents: {
          [model]: {
            command: process.execPath,
            args: [
              fileURLToPath(new URL('./fixtures/acp-session-peer.ts', import.meta.url)),
              `mode-${protocol}`,
            ],
          },
        },
        bridge: { agents: [], servers: [] },
      },
    } as unknown as Config;
    bindAcpLeaderHost({
      events: new EventBus(),
      projectRoot: process.cwd(),
      getConfig: () => config,
      permission: () => ({ evaluate: async () => ({ permission: 'deny' }) }) as never,
      context: () => ({ meta: {} }) as never,
      getTool: () => undefined,
      runTool: async () => ({ content: '', isError: true }),
    });
    const provider = new AcpLeaderProvider({ bootConfig: config, buildProvider: () => undefined });
    const command = buildAcpCommand({
      renderer: { write: () => {}, writeInfo: () => {}, writeWarning: () => {} },
      projectRoot: process.cwd(),
      cwd: process.cwd(),
      configStore: { get: () => config } as never,
    });
    const ctx = { provider, model, session: { id: sessionId }, meta: {} } as never;
    const run = async (rest = '') => (await command.run(`mode ${rest}`, ctx))?.message;
    try {
      expect(await run()).toContain('mode: default');
      if (protocol === 'modern') {
        expect(await run()).toContain(
          'toString: inspect\n  Agent offers: inspect\n  Selectable: view only',
        );
      }
      expect(await run('plan')).toContain('mode: plan');
      expect(await run('auto')).toContain('cannot switch');
      expect(await run('missing')).toContain('does not offer');

      const output: string[] = [];
      for await (const event of provider.stream(
        {
          model,
          cache: { sessionId, threadId: sessionId },
          messages: [{ role: 'user', content: [{ type: 'text', text: 'Report your mode' }] }],
        } as never,
        { signal: AbortSignal.timeout(15_000) },
      )) {
        if (event.type === 'text_delta') output.push(event.text);
      }
      expect(output.join('')).toBe('Mode plan on fresh-session');
      expect(await run('mode default')).toContain('mode: default');
    } finally {
      await provider.closeAll();
      bindAcpLeaderHost(undefined);
    }
  },
);
