// Regression coverage for the former no-op wstack-security plugin collision.
// The CLI now registers one adapter and delegates production work to
// @wrongstack/security-scanner.
import type { Context } from '@wrongstack/core/agent';
import { SlashCommandRegistry } from '@wrongstack/core/registry';
import { describe, expect, it } from 'vitest';
import { buildSecurityCommand } from '../src/slash-commands/security.js';

const projectRoot = 'C:/project';

function registry(): SlashCommandRegistry {
  const result = new SlashCommandRegistry();
  result.register(buildSecurityCommand({ cwd: projectRoot, projectRoot } as never));
  return result;
}

const context = {
  cwd: projectRoot,
  projectRoot,
  model: 'test-model',
} as Context;

describe('security command production composition', () => {
  it('routes /security scan to the real scanner backend', async () => {
    const result = await registry().dispatch('/security scan', context);
    expect(result?.message).toContain('requires an active LLM provider');
    expect(result?.message).not.toContain('dispatch bug-hunter');
  });

  it('publishes one inspect-category command with backend parity', async () => {
    const commands = registry();
    const registered = commands.get('security');
    expect(registered?.category).toBe('Inspect');
    expect(registered?.help).toContain('audit-deps');
    expect(registered?.help).toContain('redact-test');

    const result = await commands.dispatch('/security help', context);
    expect(result?.message).toContain('/security — Security Scanner');
    expect(result?.metadata?.security).toMatchObject({ action: 'help', ok: true });
  });
});
