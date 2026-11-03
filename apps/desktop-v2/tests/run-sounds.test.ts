// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAppearance } from '../src/appearance';
import { type EngineState, emptyEngineState } from '../src/engine-state';
import { useRunSounds } from '../src/RunSounds';

const chimes = vi.hoisted(() => ({ done: vi.fn(), approval: vi.fn() }));
vi.mock('@wrongstack/project-surfaces/lib/chime', () => ({
  playCompletionChime: chimes.done,
  playPermissionChime: chimes.approval,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Sounds({ state }: { state: EngineState }) {
  useRunSounds(state);
  return null;
}

const base: EngineState = { ...emptyEngineState, sessionId: 's', connected: true };
const finished = (state: EngineState): EngineState => ({
  ...state,
  results: { ...state.results, 'run.result': { status: 'done' } },
});

function mount(initial: EngineState) {
  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(Sounds, { state: initial })));
  return (next: EngineState) => act(() => root.render(createElement(Sounds, { state: next })));
}

describe('run sounds', () => {
  beforeEach(() => {
    chimes.done.mockClear();
    chimes.approval.mockClear();
    delete document.documentElement.dataset['sound'];
  });

  it('chimes when a live run finishes, only with sounds on', () => {
    const update = mount(base);
    update(finished(base));
    expect(chimes.done).not.toHaveBeenCalled();
    document.documentElement.dataset['sound'] = 'on';
    const later = finished(base);
    update({ ...later, results: { ...later.results, 'run.result': { status: 'done' } } });
    expect(chimes.done).toHaveBeenCalledOnce();
  });

  it('always chimes for a new approval, and stays quiet for history', () => {
    document.documentElement.dataset['sound'] = 'on';
    const update = mount(finished({ ...base, approvals: [{ id: 'old' }] }));
    expect(chimes.done).not.toHaveBeenCalled();
    expect(chimes.approval).not.toHaveBeenCalled();
    update({ ...base, approvals: [{ id: 'old' }, { id: 'new' }] });
    expect(chimes.approval).toHaveBeenCalledOnce();
    update(finished({ ...base, hydrating: true }));
    expect(chimes.done).not.toHaveBeenCalled();
  });

  it('keeps the setting with the appearance', () => {
    expect(parseAppearance('{"sound":"on"}')).toMatchObject({ sound: 'on' });
    expect(parseAppearance('{"sound":"loud"}')).not.toHaveProperty('sound');
  });
});
