import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { ProviderModelStatusTracker } from '@wrongstack/core/coordination';
import { describe, expect, it } from 'vitest';
import { buildProviderStatusCommand } from '../src/slash-commands/provider-status.js';

describe('/provider-status waiting room', () => {
  it('shows only blocked entries in the waiting view', async () => {
    const tracker = new ProviderModelStatusTracker();
    tracker.recordFailure('omniroute', 'cc/claude-opus-4.8', 'rate_limit', 429, 'credit exhausted');
    tracker.recordFailure('other', 'healthy-model', 'server', 500, 'temporary');

    const result = await buildProviderStatusCommand(tracker).run('waiting');

    expect((result as { message?: string })?.message).toContain('cc/claude-opus-4.8');
    expect((result as { message?: string })?.message).not.toContain('omniroute/cc/claude-opus-4.8');
    expect((result as { message?: string })?.message).not.toContain('other/healthy-model');
  });

  it('releases a namespaced OmniRoute model for a half-open probe', async () => {
    const tracker = new ProviderModelStatusTracker();
    tracker.recordFailure('omniroute', 'cc/claude-opus-4.8', 'rate_limit', 429, 'credit exhausted');

    const result = await buildProviderStatusCommand(tracker).run('retry cc claude-opus-4.8');

    expect((result as { message?: string })?.message).toContain('half-open probe');
    expect(tracker.isAvailable('omniroute', 'cc/claude-opus-4.8')).toBe(true);
  });

  it('tails the durable audit history without reading the file manually', async () => {
    const home = mkdtempSync(`${tmpdir()}/wstack-audit-history-`.replaceAll('\\', '/'));
    const prevHome = process.env.WRONGSTACK_HOME;
    process.env.WRONGSTACK_HOME = home.replaceAll('\\', '/');
    try {
      const { resolveWstackPaths } = await import('@wrongstack/core/utils');
      const paths = resolveWstackPaths({ projectRoot: process.cwd() });
      const auditFile = paths.profileProviderAudit(paths.profileName);
      mkdirSync(dirname(auditFile), { recursive: true });
      const blockLine = JSON.stringify({
        ts: Date.now() - 60_000,
        providerId: 'test-provider',
        model: 'test-model',
        from: 'healthy',
        to: 'blocked',
        reason: 'rate_limit_threshold_1',
        expiresAt: Date.now(),
        error: {
          kind: 'rate_limit',
          status: 429,
          message: 'Simulated 429',
          sessionId: 'sess_hist',
          agentId: 'agent_hist',
        },
      });
      const openLine = JSON.stringify({
        ts: Date.now() - 30_000,
        providerId: 'test-provider',
        model: 'test-model',
        from: 'blocked',
        to: 'healthy',
        reason: 'manual_half_open',
        expiresAt: null,
        error: null,
      });
      writeFileSync(auditFile, `${blockLine}\n${openLine}\n`);

      const result = await buildProviderStatusCommand(new ProviderModelStatusTracker()).run(
        'history 5',
      );

      const message = (result as { message?: string })?.message ?? '';
      expect(message).toContain('test-provider/test-model');
      expect(message).toContain('healthy → blocked');
      expect(message).toContain('blocked → healthy');
      expect(message).toContain('rate limit threshold 1');
      expect(message).toContain('rate_limit');
      expect(message).toContain('sess_hist');
      expect(message).toContain('Audit History');
    } finally {
      if (prevHome === undefined) delete process.env.WRONGSTACK_HOME;
      else process.env.WRONGSTACK_HOME = prevHome;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
