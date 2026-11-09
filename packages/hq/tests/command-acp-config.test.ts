import { expect, it } from 'vitest';
import { isHqAcpConfigResult, parseHqAcpConfig } from '../src/command-acp-config.js';
import { parseHqFrame } from '../src/protocol/core.js';

it('requires an exact session and validates bounded native values', () => {
  expect(parseHqAcpConfig({ action: 'inspect', agentId: 'codex-cli' })).toBeNull();
  expect(
    parseHqAcpConfig({
      action: 'set',
      agentId: 'codex-cli',
      sessionId: 's',
      values: { thought: 4 },
      expected: {},
    }),
  ).toBeNull();
  expect(
    parseHqAcpConfig({
      action: 'set',
      agentId: 'codex-cli',
      sessionId: 's',
      values: { thought: 'ultra' },
      expected: {},
    }),
  ).toMatchObject({ values: { thought: 'ultra' }, sessionId: 's' });
});
it('preserves structured selector acknowledgements and rejects oversized responses', () => {
  const acpConfig = { agentId: 'fixture', options: [], applied: {} };
  expect(isHqAcpConfigResult(acpConfig)).toBe(true);
  const decoded = parseHqFrame(
    JSON.stringify({
      type: 'client.command_ack',
      clientId: 'client',
      projectId: 'p',
      commandId: 'c',
      status: 'completed',
      acpConfig,
    }),
  );
  expect(decoded).toMatchObject({ ok: true, frame: { acpConfig } });
  expect(
    isHqAcpConfigResult({
      ...acpConfig,
      options: [
        {
          id: 'm',
          name: 'M',
          currentValue: 'a',
          options: Array.from({ length: 200 }, (_, i) => ({
            value: String(i),
            name: 'a'.repeat(2000),
          })),
        },
      ],
    }),
  ).toBe(false);
});
