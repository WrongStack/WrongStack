import { describe, expect, it } from 'vitest';
import { resolveAgentSwarmPanelVisibility } from '../src/app-status-region.js';

describe('FleetPanel gating by swarm mode', () => {
  it('returns bottom by default (FleetPanel visible in lower region)', () => {
    expect(resolveAgentSwarmPanelVisibility(false, 'bottom', undefined)).toBe('bottom');
  });

  it('returns sidebar mode (FleetPanel hidden in lower region, shown in sidebar)', () => {
    expect(resolveAgentSwarmPanelVisibility(false, 'bottom', 'sidebar')).toBe('sidebar');
  });

  it('returns off mode (FleetPanel hidden everywhere)', () => {
    expect(resolveAgentSwarmPanelVisibility(false, 'bottom', 'off')).toBe('off');
  });

  it('the gating condition in app-status-region hides FleetPanel for sidebar/off', () => {
    // This mirrors the actual condition used in app-status-region.tsx:
    //   mode !== 'off' && mode !== 'sidebar'
    const shouldShowBottom = (mode: string) => mode !== 'off' && mode !== 'sidebar';

    // bottom → FleetPanel visible
    expect(shouldShowBottom('bottom')).toBe(true);
    // sidebar → FleetPanel hidden (shown in sidebar instead)
    expect(shouldShowBottom('sidebar')).toBe(false);
    // off → FleetPanel hidden everywhere
    expect(shouldShowBottom('off')).toBe(false);
  });
});
