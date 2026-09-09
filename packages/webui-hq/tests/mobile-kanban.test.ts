import { describe, expect, it } from 'vitest';
import {
  canAssignKanbanTask,
  canDispatchKanbanTask,
  kanbanTransitionOptions,
  mobileKanbanAssignmentTargets,
  suggestedKanbanStage,
} from '../src/mobile/mobile-kanban.js';

describe('mobile Kanban transition suggestions', () => {
  it.each([
    ['pending', 'todo'],
    ['ready', 'running'],
    ['in_progress', 'review'],
    ['review', 'done'],
    ['completed', 'done'],
    ['archived', 'todo'],
  ])('maps %s to %s without bypassing lifecycle stages', (status, expected) => {
    expect(suggestedKanbanStage({ status })).toBe(expected);
  });

  it('offers only adjacent stages and treats done as terminal', () => {
    expect(kanbanTransitionOptions({ status: 'in_progress', lifecycleStage: 'running' })).toEqual([
      'todo',
      'review',
    ]);
    expect(kanbanTransitionOptions({ status: 'completed', lifecycleStage: 'done' })).toEqual([]);
  });

  it('does not offer assignment over an active owner or for a terminal card', () => {
    expect(canAssignKanbanTask({ status: 'ready', assignmentStatus: 'assigned' })).toBe(true);
    expect(canAssignKanbanTask({ status: 'in_progress', assignmentStatus: 'running' })).toBe(false);
    expect(canAssignKanbanTask({ status: 'completed', lifecycleStage: 'done' })).toBe(false);
  });

  it('dispatches only a To Do card without an active claim', () => {
    expect(canDispatchKanbanTask({ status: 'ready', lifecycleStage: 'todo' })).toBe(true);
    expect(
      canDispatchKanbanTask({
        status: 'ready',
        lifecycleStage: 'todo',
        assignmentStatus: 'queued',
      }),
    ).toBe(false);
    expect(canDispatchKanbanTask({ status: 'in_progress', lifecycleStage: 'running' })).toBe(false);
  });

  it('offers only agents visible in the selected project as assignment targets', () => {
    const snapshot = {
      liveSessions: [
        {
          sessionId: 'session-a',
          projectId: 'project-a',
          hostname: 'host-a',
          agents: [{ id: 'reviewer-1', name: 'Reviewer', status: 'idle' }],
        },
        {
          sessionId: 'session-b',
          projectId: 'project-b',
          machineId: 'machine-b',
          agents: [{ id: 'foreign-1', name: 'Foreign', status: 'running' }],
        },
      ],
    } as never;
    expect(mobileKanbanAssignmentTargets(snapshot, 'project-a')).toEqual([
      {
        key: 'session-a:reviewer-1',
        agentId: 'reviewer-1',
        label: 'Reviewer · host-a · idle',
      },
    ]);
  });
});
