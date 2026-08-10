import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { KanbanViewModeTabs } from '../../src/components/KanbanViewModeTabs.js';

describe('KanbanViewModeTabs', () => {
  it('opens the cross-board Focus workbench as a first-class view', () => {
    const onChange = vi.fn();
    render(<KanbanViewModeTabs viewMode="board" onViewModeChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Focus' }));
    expect(onChange).toHaveBeenCalledWith('focus');
  });

  it('exposes the board-wide Contract Map as a first-class view', () => {
    const onChange = vi.fn();
    render(<KanbanViewModeTabs viewMode="board" onViewModeChange={onChange} />);

    fireEvent.click(screen.getByRole('button', { name: 'Contract Map' }));
    expect(onChange).toHaveBeenCalledWith('contracts');
  });
});
