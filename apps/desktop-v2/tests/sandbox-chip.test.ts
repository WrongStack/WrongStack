// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SandboxChip } from '../src/SandboxChip';
import { readSandboxStatus, sandboxChipKey } from '../src/sandbox-status';
import { surfaceI18n } from '../src/surface-i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('the sandbox posture', () => {
  it('reads the status route’s reply and names the tier only when enforced', () => {
    expect(readSandboxStatus({})).toBeNull();
    expect(readSandboxStatus({ sandbox: { mode: '' } })).toBeNull();
    const off = readSandboxStatus({
      sandbox: { mode: 'off', tier: 'read-only', backend: 'none' },
    })!;
    expect(sandboxChipKey(off)).toBe('off');
    const enforced = (tier: string) =>
      sandboxChipKey(
        readSandboxStatus({ sandbox: { mode: 'enforced', tier, backend: 'seatbelt' } })!,
      );
    expect(enforced('read-only')).toBe('readOnly');
    expect(enforced('workspace-write')).toBe('workspaceWrite');
    expect(enforced('danger-full-access')).toBe('full');
  });
});

describe('the sandbox chip', () => {
  afterAll(async () => {
    await surfaceI18n.changeLanguage('en');
  });

  it('stays hidden until the engine answers, then polls and keeps the last posture on failure', async () => {
    await surfaceI18n.changeLanguage('en');
    vi.useFakeTimers();
    const replies: Array<() => unknown> = [
      () => {
        throw new Error('Engine is still starting');
      },
      () => ({ sandbox: { mode: 'enforced', tier: 'workspace-write', backend: 'seatbelt' } }),
      () => {
        throw new Error('gone');
      },
    ];
    const http = vi.fn(async (resource: string) => {
      expect(resource).toBe('/api/sandbox/status');
      return replies.shift()?.();
    });
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () =>
      root.render(createElement(SandboxChip, { sessionId: 's', http, pollMs: 1000 })),
    );
    expect(host.textContent).toBe('');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const chip = host.querySelector('[data-testid="sandbox-status"]');
    expect(chip?.textContent).toBe('Sandbox · workspace write');
    expect(chip?.getAttribute('title')).toContain('backend seatbelt');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(http).toHaveBeenCalledTimes(3);
    expect(host.textContent).toBe('Sandbox · workspace write');
    await act(async () => {
      await surfaceI18n.changeLanguage('tr');
    });
    expect(host.textContent).toBe('Korumalı alan · çalışma alanına yazma');
    act(() => root.unmount());
    vi.useRealTimers();
  });
});
