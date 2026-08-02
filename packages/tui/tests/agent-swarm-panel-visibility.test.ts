import { describe, expect, it } from 'vitest';
import { resolveAgentSwarmPanelVisibility } from '../src/app-status-region.js';
import type { AgentSwarmPanelMode } from '../src/app-settings-type.js';

describe('resolveAgentSwarmPanelVisibility', () => {
  it('defaults the persistent panel to visible when no setting is stored', () => {
    expect(resolveAgentSwarmPanelVisibility(false, 'off', undefined)).toBe('bottom');
  });

  it('uses the persisted setting while the settings picker is closed', () => {
    const picker: AgentSwarmPanelMode = 'bottom';
    const persisted: AgentSwarmPanelMode = 'sidebar';
    expect(resolveAgentSwarmPanelVisibility(false, picker, persisted)).toBe('sidebar');
    expect(resolveAgentSwarmPanelVisibility(false, 'sidebar', 'off')).toBe('off');
  });

  it('previews the picker value live while /settings is open', () => {
    expect(resolveAgentSwarmPanelVisibility(true, 'sidebar', 'off')).toBe('sidebar');
    expect(resolveAgentSwarmPanelVisibility(true, 'off', 'bottom')).toBe('off');
  });
});
