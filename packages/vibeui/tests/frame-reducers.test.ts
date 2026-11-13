import { describe, expect, it } from 'vitest';
import { FRAME_REDUCERS, frameReducer, mergeFrameReducers } from '../src/lib/reducers';
import type { initialState } from '../src/lib/session';

describe('frame reducer table', () => {
  it('owns every per-frame-type case that used to live in the reduceFrame switch', () => {
    expect(Object.keys(FRAME_REDUCERS).sort()).toEqual(
      [
        'agent.status_changed',
        'agent.timeline.message',
        'chimera.report_available',
        'context.compacted',
        'coordinator.stats',
        'ctx.max_context',
        'ctx.pct',
        'files.image',
        'files.list',
        'files.read',
        'files.tree',
        'git.changes',
        'git.diff',
        'iteration.started',
        'key.operation_result',
        'mode.switched',
        'model.switch_result',
        'modes.list',
        'plan.updated',
        'prefs.updated',
        'provider.catalog',
        'provider.model_switched',
        'provider.models',
        'provider.retry',
        'session.run_state',
        'sessions.list',
        'sessions.status_update',
        'stats.get',
        'subagent.event',
        'tasks.updated',
        'todos.cleared',
        'todos.updated',
        'tool.confirm_needed',
        'tool.confirm_resolved',
        'user.input_requested',
        'user.input_resolved',
      ].sort(),
    );
    expect(Object.isFrozen(FRAME_REDUCERS)).toBe(true);
  });

  it('rejects a frame type claimed by two areas', () => {
    const reducer = (state: ReturnType<typeof initialState>) => state;
    expect(() => mergeFrameReducers([{ 'a.b': reducer }, { 'a.b': reducer }])).toThrow(
      'Duplicate frame reducer: a.b',
    );
  });

  it('never resolves Object.prototype members as frame types', () => {
    for (const type of ['constructor', 'toString', 'hasOwnProperty', '__proto__'])
      expect(frameReducer(FRAME_REDUCERS, type)).toBeUndefined();
    expect(frameReducer(FRAME_REDUCERS, 'git.diff')).toBeTypeOf('function');
  });
});
