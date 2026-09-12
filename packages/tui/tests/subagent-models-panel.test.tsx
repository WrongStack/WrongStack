import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { createInitialState } from '../src/app-initial-state.js';
import { reducer } from '../src/app-reducer.js';
import { SubagentModelsPanel } from '../src/components/subagent-models-panel.js';

function baseState() {
  return createInitialState({
    banner: false,
    appVersion: '0.0.0',
    provider: 'anthropic',
    model: 'anthropic-test-model',
    cwd: '/repo',
    family: 'anthropic',
    keyTail: 'abcd',
    restoredEntries: [],
    enhanceEnabled: false,
    initialAgentsMonitorOpen: false,
  });
}

const lanes = [
  { target: 'anthropic/claude-opus-5', busy: 1 },
  { target: '', busy: 0 },
  { target: 'openai/gpt-5', busy: 0, label: 'cheap lane' },
];

describe('SubagentModelsPanel', () => {
  it('renders lanes, the busy marker and the lock state', () => {
    const { lastFrame } = render(
      <SubagentModelsPanel
        lanes={lanes}
        roles={[]}
        selected={0}
        enabled
        lock
        followSessionModel={false}
        sessionTarget="openai/gpt-5"
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('anthropic/claude-opus-5');
    expect(frame).toContain('cheap lane');
    expect(frame).toContain('inherit');
    expect(frame).toContain('lanes override the leader');
  });

  it('says the leader wins when the lock is off', () => {
    const { lastFrame } = render(
      <SubagentModelsPanel
        lanes={lanes}
        roles={[]}
        selected={0}
        enabled
        lock={false}
        followSessionModel={false}
        sessionTarget="openai/gpt-5"
      />,
    );
    expect(lastFrame() ?? '').toContain('leader pins win');
  });

  it('renders role overrides when present', () => {
    const { lastFrame } = render(
      <SubagentModelsPanel
        lanes={lanes}
        roles={[{ role: 'reviewer', target: 'openai/gpt-5' }]}
        selected={1}
        enabled
        lock
        followSessionModel={false}
        sessionTarget="openai/gpt-5"
      />,
    );
    expect(lastFrame() ?? '').toContain('reviewer');
  });
});

describe('SubagentModelsPanel — use session model', () => {
  it('names the session target and marks the lanes inactive', () => {
    const { lastFrame } = render(
      <SubagentModelsPanel
        lanes={lanes}
        roles={[]}
        selected={0}
        enabled
        lock
        followSessionModel
        sessionTarget="openai/gpt-5"
      />,
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('openai/gpt-5');
    expect(frame).toContain('lanes are inactive');
  });
});

describe('subagentModels reducer', () => {
  const open = () =>
    reducer(baseState(), {
      type: 'subagentModelsOpen',
      lanes,
      roles: [],
      enabled: true,
      lock: true,
      followSessionModel: false,
      sessionTarget: 'openai/gpt-5',
    });

  it('opens with the first lane focused', () => {
    const state = open();
    expect(state.subagentModels.open).toBe(true);
    expect(state.subagentModels.selected).toBe(0);
    expect(state.subagentModels.lanes).toHaveLength(3);
  });

  it('wraps the cursor at both ends', () => {
    let state = open();
    state = reducer(state, { type: 'subagentModelsMove', delta: -1 });
    expect(state.subagentModels.selected).toBe(2);
    state = reducer(state, { type: 'subagentModelsMove', delta: 1 });
    expect(state.subagentModels.selected).toBe(0);
  });

  it('keeps the cursor in range when the lane list shrinks', () => {
    let state = open();
    state = reducer(state, { type: 'subagentModelsMove', delta: 2 });
    expect(state.subagentModels.selected).toBe(2);
    state = reducer(state, {
      type: 'subagentModelsUpdate',
      lanes: [lanes[0] as (typeof lanes)[number]],
      roles: [],
      enabled: true,
      lock: false,
      followSessionModel: false,
      sessionTarget: 'openai/gpt-5',
    });
    expect(state.subagentModels.selected).toBe(0);
    expect(state.subagentModels.lock).toBe(false);
  });

  it('closes without losing the rows', () => {
    const state = reducer(open(), { type: 'subagentModelsClose' });
    expect(state.subagentModels.open).toBe(false);
    expect(state.subagentModels.lanes).toHaveLength(3);
  });

  it('does not move when there are no lanes', () => {
    const empty = reducer(baseState(), {
      type: 'subagentModelsOpen',
      lanes: [],
      roles: [],
      enabled: true,
      lock: true,
      followSessionModel: false,
      sessionTarget: 'openai/gpt-5',
    });
    expect(reducer(empty, { type: 'subagentModelsMove', delta: 1 }).subagentModels.selected).toBe(
      0,
    );
  });
});

describe('panel open bridge', () => {
  it('routes subagentModelsOpen to the opener', async () => {
    const { createPanelOpenDispatcher } = await import('../src/on-panel-open.js');
    const openSubagentModelsPanel = vi.fn();
    const dispatcher = createPanelOpenDispatcher({
      dispatch: vi.fn(),
      openProjectPicker: vi.fn(),
      openStatuslinePicker: vi.fn(),
      openSubagentModelsPanel,
    } as never);
    expect(dispatcher('subagentModelsOpen')).toBe(true);
    expect(openSubagentModelsPanel).toHaveBeenCalled();
  });

  it('falls back to text when no opener is wired', async () => {
    const { createPanelOpenDispatcher } = await import('../src/on-panel-open.js');
    const dispatcher = createPanelOpenDispatcher({
      dispatch: vi.fn(),
      openProjectPicker: vi.fn(),
      openStatuslinePicker: vi.fn(),
    } as never);
    expect(dispatcher('subagentModelsOpen')).toBe(false);
  });
});
