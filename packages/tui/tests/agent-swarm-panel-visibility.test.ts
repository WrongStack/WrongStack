import { describe, expect, it } from 'vitest';
import { resolveAgentSwarmPanelVisibility } from '../src/app-status-region.js';

describe('resolveAgentSwarmPanelVisibility', () => {
  it('defaults the persistent panel to visible when no setting is stored', () => {
    expect(resolveAgentSwarmPanelVisibility(false, 'off' as never, undefined)).toBe('bottom');
  });

  it('uses the persisted setting while the settings picker is closed', () => {
    expect(resolveAgentSwarmPanelVisibility(false, 'bottom' as never, 'sidebar')).toBe('sidebar');
    expect(resolveAgentSwarmPanelVisibility(false, 'sidebar' as never, 'off')).toBe('off');
  });

  it('previews the picker value live while /settings is open', () => {
    expect(resolveAgentSwarmPanelVisibility(true, 'sidebar' as never, 'off')).toBe('sidebar');
    expect(resolveAgentSwarmPanelVisibility(true, 'off' as never, 'bottom')).toBe('off');
  });
});
