import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { SidebarContent } from '../src/components/sidebar-content.js';
import type { TodoItem } from '@wrongstack/core/agent';

const WIDTH = 40;

function makeTodo(
  id: string,
  status: TodoItem['status'],
  content: string,
  activeForm?: string,
): TodoItem {
  return { id, status, content, activeForm };
}

function renderSidebar(todos: readonly TodoItem[], showSwarmSection: boolean) {
  const { lastFrame } = render(
    React.createElement(SidebarContent, {
      contextWindow: { used: 1, max: 10 },
      entries: {},
      fleetCounts: undefined,
      width: WIDTH,
      showSwarmSection,
      todos,
    }),
  );
  return lastFrame() ?? '';
}

describe('SidebarContent mission queue', () => {
  it('sorts in_progress → pending → completed and shows a done/total badge', () => {
    const todos = [
      makeTodo('t1', 'pending', 'Pending task'),
      makeTodo('t2', 'in_progress', 'Original content', 'Active form label'),
      makeTodo('t3', 'completed', 'Done task'),
    ];
    const frame = renderSidebar(todos, true);

    expect(frame).toContain('MISSIONS');
    expect(frame).toContain('1/3'); // done/total badge

    // in_progress uses its activeForm, not its content
    expect(frame).toContain('Active form label');
    expect(frame).not.toContain('Original content');

    // ordering: in_progress before pending before completed
    const iActive = frame.indexOf('Active form label');
    const iPending = frame.indexOf('Pending task');
    const iDone = frame.indexOf('Done task');
    expect(iActive).toBeGreaterThan(-1);
    expect(iPending).toBeGreaterThan(iActive);
    expect(iDone).toBeGreaterThan(iPending);
  });

  it('shows up to 8 missions with a +N more overflow line', () => {
    const todos = Array.from({ length: 11 }, (_, i) =>
      makeTodo(`t${i}`, 'pending', `Task ${String(i).padStart(2, '0')}`),
    );
    const frame = renderSidebar(todos, true);

    // 11 todos, cap 8 → +3 more
    expect(frame).toContain('+3 more');

    // exactly 8 mission rows visible (stable order keeps the first 8)
    let visible = 0;
    for (let i = 0; i < 11; i++) {
      if (frame.includes(`Task ${String(i).padStart(2, '0')}`)) visible++;
    }
    expect(visible).toBe(8);
  });

  it('does not render the mission queue when showSwarmSection is false', () => {
    const todos = [makeTodo('t1', 'pending', 'Hidden task')];
    const frame = renderSidebar(todos, false);

    expect(frame).not.toContain('MISSIONS');
    expect(frame).not.toContain('Hidden task');
  });

  it('does not render the mission queue when there are no todos', () => {
    const frame = renderSidebar([], true);
    expect(frame).not.toContain('MISSIONS');
  });
});
