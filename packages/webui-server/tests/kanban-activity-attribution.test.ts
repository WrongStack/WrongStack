import type { Context } from '@wrongstack/core/agent';
import { describe, expect, it } from 'vitest';
import {
  actingSessionId,
  activityContext,
  type KanbanRouteHelperContext,
} from '../src/server/kanban-route-helpers.js';

/**
 * Kanban activity is attributed to the tab that did it.
 *
 * Boards are addressed by `boardId`, so their contents never crossed tabs —
 * but every activity entry and presence ping was stamped with
 * `context.session`, the session the RUNTIME last switched to. With four tabs
 * open, tab 3 moving a card was recorded as tab 1's work, which makes the
 * board history actively misleading rather than merely incomplete.
 */

function ctx(requestSessionId?: string): KanbanRouteHelperContext {
  return {
    projectRoot: '/repo',
    context: { session: { id: 'runtime-tab-1' } } as unknown as Context,
    ...(requestSessionId ? { requestSessionId } : {}),
  };
}

describe('kanban activity attribution', () => {
  it('credits the tab that sent the message', () => {
    expect(actingSessionId(ctx('tab-3'))).toBe('tab-3');
    expect(activityContext(ctx('tab-3'), 'webui').sessionId).toBe('tab-3');
  });

  it('falls back to the runtime session when the message names none', () => {
    // Single-session hosts and older clients never stamp one; their behaviour
    // is unchanged.
    expect(actingSessionId(ctx())).toBe('runtime-tab-1');
    expect(activityContext(ctx(), 'webui').sessionId).toBe('runtime-tab-1');
  });

  it('carries the actor and note through unchanged', () => {
    const event = activityContext(ctx('tab-2'), 'webui', '  moved to review  ');
    expect(event).toEqual({ sessionId: 'tab-2', actor: 'webui', note: 'moved to review' });
  });

  it('refuses to attribute a mutation when there is no session to name', () => {
    // Every WebUI board mutation arrives on a tab's socket. A context with no
    // acting session is a route that dropped `requestSessionId`, not a state
    // worth writing an unattributed durable event from.
    expect(() => activityContext({ projectRoot: '/repo' }, 'webui')).toThrow(
      expect.objectContaining({ code: 'SESSION_ID_REQUIRED' }),
    );
  });
});
