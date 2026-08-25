import { beforeEach, describe, expect, it } from 'vitest';
import { useUIStore } from '../../src/stores/ui-store';

describe('Universal Inspector Target Routing in ui-store', () => {
  beforeEach(() => {
    useUIStore.setState({
      inspectorOpen: false,
      inspectorTab: 'fleet',
      inspectorTarget: null,
      inspectorFocusedAgentId: null,
    });
  });

  it('routes to fleet inspector tab when kind is fleet', () => {
    useUIStore.getState().openInspectorTarget({ kind: 'fleet', tab: 'fleet' });

    expect(useUIStore.getState().inspectorOpen).toBe(true);
    expect(useUIStore.getState().inspectorTab).toBe('fleet');
    expect(useUIStore.getState().inspectorTarget).toEqual({ kind: 'fleet', tab: 'fleet' });
  });

  it('routes to agent card inspector tab with focusedAgentId when kind is agent', () => {
    useUIStore.getState().openInspectorTarget({ kind: 'agent', agentId: 'agent-42' });

    expect(useUIStore.getState().inspectorOpen).toBe(true);
    expect(useUIStore.getState().inspectorTab).toBe('agents');
    expect(useUIStore.getState().inspectorFocusedAgentId).toBe('agent-42');
    expect(useUIStore.getState().inspectorTarget).toEqual({ kind: 'agent', agentId: 'agent-42' });
  });

  it('routes to sideEffects audit tab when kind is sideEffects', () => {
    useUIStore.getState().openInspectorTarget({ kind: 'sideEffects' });

    expect(useUIStore.getState().inspectorOpen).toBe(true);
    expect(useUIStore.getState().inspectorTab).toBe('sideEffects');
  });

  it('routes to council log tab when kind is council', () => {
    useUIStore.getState().openInspectorTarget({ kind: 'council' });

    expect(useUIStore.getState().inspectorOpen).toBe(true);
    expect(useUIStore.getState().inspectorTab).toBe('council');
  });

  it('closes inspector and resets target on closeInspector', () => {
    useUIStore.getState().openInspectorTarget({ kind: 'council' });
    expect(useUIStore.getState().inspectorOpen).toBe(true);

    useUIStore.getState().closeInspector();
    expect(useUIStore.getState().inspectorOpen).toBe(false);
    expect(useUIStore.getState().inspectorTarget).toBeNull();
  });
});
