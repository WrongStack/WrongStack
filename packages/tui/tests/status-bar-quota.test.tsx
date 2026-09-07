/**
 * The `quota` statusline chip.
 *
 * The chip reads the provider-neutral quota store directly rather than taking
 * a prop, so what is worth pinning is the wiring: nothing renders before a
 * provider has reported, the chip appears once one has, and the number shown is
 * the window nearest to cutting the user off — across providers, not the first
 * one to report.
 */

import { recordProviderQuota, resetProviderQuota } from '@wrongstack/core/quota';
import { afterEach, describe, expect, it } from 'vitest';
import { StatusBar, type StatusBarProps } from '../src/components/status-bar.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

afterEach(() => {
  resetProviderQuota();
});

const baseProps = {
  provider: 'openai-codex',
  model: 'gpt-5-codex',
  state: 'idle',
  mode: 'detailed',
} as unknown as StatusBarProps;

async function render(): Promise<string> {
  const r = renderRealTty(<StatusBar {...baseProps} />, { columns: 140 });
  await settle();
  const out = r.lastFrame();
  r.unmount();
  return out;
}

function quotaWindow(usedPercent: number, over: Record<string, unknown> = {}) {
  return { id: 'primary', usedPercent, windowMinutes: 300, ...over };
}

describe('the quota chip', () => {
  it('renders nothing until a provider has reported', async () => {
    expect(await render()).not.toContain('%');
  });

  it('shows the window label and burn once a provider reports', async () => {
    recordProviderQuota('openai-codex', [
      {
        providerId: 'openai-codex',
        meterId: 'codex',
        windows: [quotaWindow(51)],
        capturedAt: Date.now(),
      },
    ]);
    const out = await render();
    expect(out).toContain('5h');
    expect(out).toContain('51%');
  });

  it('shows the most-consumed window across providers, not the first reported', async () => {
    recordProviderQuota('openai-codex', [
      {
        providerId: 'openai-codex',
        meterId: 'codex',
        windows: [quotaWindow(20)],
        capturedAt: Date.now(),
      },
    ]);
    recordProviderQuota('anthropic-oauth', [
      {
        providerId: 'anthropic-oauth',
        meterId: 'default',
        windows: [quotaWindow(93, { windowMinutes: 10080 })],
        capturedAt: Date.now(),
      },
    ]);
    const out = await render();
    expect(out).toContain('93%');
    expect(out).toContain('7d');
    expect(out).not.toContain('20%');
  });

  it('shows the countdown when the provider published a reset time', async () => {
    recordProviderQuota('openai-codex', [
      {
        providerId: 'openai-codex',
        meterId: 'codex',
        windows: [quotaWindow(80, { resetsAt: Math.floor(Date.now() / 1000) + 2 * 3600 })],
        capturedAt: Date.now(),
      },
    ]);
    expect(await render()).toContain('1h 59m');
  });
});
