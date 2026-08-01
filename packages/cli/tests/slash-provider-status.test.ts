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
});
