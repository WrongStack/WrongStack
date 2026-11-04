import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { KanbanBoardPresence } from '@wrongstack/kanban';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BoardPresence,
  PRESENCE_RECENT_INACTIVE,
  visiblePresence,
} from '../../src/components/KanbanBoardChrome';

const entry = (id: string, active: boolean, lastSeenAt: string): KanbanBoardPresence =>
  ({
    id,
    active,
    lastSeenAt,
    sessionId: `s-${id}`,
    agentId: id,
    agentName: id,
  }) as KanbanBoardPresence;

afterEach(cleanup);

describe('board presence', () => {
  const stale = Array.from({ length: 30 }, (_, index) =>
    entry(`supervisor-${index}`, false, `2026-10-2${index % 10}T00:00:00Z`),
  );
  const presence = [...stale, entry('leader', true, '2026-11-03T09:00:00Z')];

  it('shows every active entry and only the most recently seen inactive ones', () => {
    const { shown, hidden } = visiblePresence(presence, false);
    expect(shown[0]?.id).toBe('leader');
    expect(shown).toHaveLength(1 + PRESENCE_RECENT_INACTIVE);
    expect(hidden).toBe(30 - PRESENCE_RECENT_INACTIVE);
    expect(shown.slice(1).every((item) => item.lastSeenAt.startsWith('2026-10-29'))).toBe(true);
  });

  it('opens and folds the earlier entries on request', () => {
    render(<BoardPresence presence={presence} />);
    expect(screen.getAllByRole('img', { name: 'inactive' })).toHaveLength(PRESENCE_RECENT_INACTIVE);
    fireEvent.click(
      screen.getByRole('button', { name: `+${30 - PRESENCE_RECENT_INACTIVE} earlier` }),
    );
    expect(screen.getAllByRole('img', { name: 'inactive' })).toHaveLength(30);
    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(screen.getAllByRole('img', { name: 'inactive' })).toHaveLength(PRESENCE_RECENT_INACTIVE);
  });

  it('offers no toggle when nothing is folded', () => {
    render(<BoardPresence presence={presence.slice(-3)} />);
    expect(screen.queryByRole('button')).toBeNull();
  });
});
