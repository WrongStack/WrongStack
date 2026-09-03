import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { State } from '../src/app.js';
import { CoordinatorPanel } from '../src/components/coordinator-panel.js';
import { FKeyPicker } from '../src/components/f-key-picker.js';
import { STATUSLINE_ITEMS, StatuslinePicker } from '../src/components/statusline-picker.js';

describe('adjacent F-key surfaces', () => {
  it('keeps the /f launcher centered on the selected function key', () => {
    const view = render(React.createElement(FKeyPicker, { selected: 11 }));
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('FUNCTION KEYS');
    expect(frame).toContain('F12');
    expect(frame).toContain('Kanban board panel');
    expect(frame).toContain('13 surfaces');
    view.unmount();
  });

  it('bounds a large F11 coordinator board and navigates to later goals', async () => {
    const coordinator: State['coordinator'] = {
      goals: Array.from({ length: 9 }, (_, goalIndex) => ({
        id: `goal-${goalIndex + 1}`,
        title: `coordinated-goal-${goalIndex + 1}`,
        status: 'active' as const,
        progress: 50,
        participants: ['leader', 'worker'],
        tasks: Array.from({ length: 9 }, (_, taskIndex) => ({
          id: `g${goalIndex + 1}-task-${taskIndex + 1}`,
          title: `task-${goalIndex + 1}-${taskIndex + 1}`,
          status: taskIndex === 0 ? ('running' as const) : ('pending' as const),
          ...(taskIndex === 0 ? { assignedTo: 'worker' } : {}),
        })),
      })),
      timeline: Array.from({ length: 12 }, (_, index) => ({
        at: 10_000 - index * 100,
        kind: 'task' as const,
        icon: '·',
        text: `activity-${index + 1}`,
      })),
      knowledgeCount: 14,
      monitorOpen: true,
      healthy: true,
    };
    const view = render(
      React.createElement(CoordinatorPanel, {
        coordinator,
        nowTick: 11_000,
        onClose: vi.fn(),
      }),
    );
    expect(view.lastFrame() ?? '').toContain('coordinated-goal-1');
    expect(view.lastFrame() ?? '').not.toContain('coordinated-goal-8');

    for (let index = 0; index < 7; index++) {
      view.stdin.write('\u001B[B');
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('coordinated-goal-8');
    expect(frame).toContain('goals');
    expect(frame).toContain('TASKS');
    expect(frame).not.toContain('task-8-9');
    view.unmount();
  });

  it('renders F12 as a responsive, windowed chip editor', async () => {
    const field = 30;
    const view = render(
      React.createElement(StatuslinePicker, {
        field,
        hiddenItems: ['cache', 'cost'],
        visibleChips: [],
        hint: 'Visibility updated',
      }),
    );
    Object.defineProperty(view.stdout, 'columns', { configurable: true, value: 58 });
    Object.defineProperty(view.stdout, 'rows', { configurable: true, value: 18 });
    process.stdout.emit('resize');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('STATUS LINE');
    expect(frame).toContain(STATUSLINE_ITEMS[field]);
    expect(frame).toContain('Visibility updated');
    expect(frame).toContain('more');
    expect(Math.max(...frame.split('\n').map((line) => line.length))).toBeLessThanOrEqual(60);
    view.unmount();
  });
});
