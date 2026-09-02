import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ModelPicker } from '../../src/components/ModelPicker.js';
import { FallbackEditor } from '../../src/components/FallbackEditor.js';
import { SddTaskDrawer } from '../../src/components/SddTaskDrawer.js';
import type { ModelCandidate } from '../../src/hooks/useProviderModels.js';
import type { BoardTaskItem } from '../../src/stores/index.js';

const CANDIDATES: ModelCandidate[] = [
  { provider: 'anthropic', model: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { provider: 'openai', model: 'gpt-5', label: 'GPT-5' },
];

describe('ModelPicker', () => {
  it('opens, lists candidates, and emits the chosen model + provider', () => {
    const onPick = vi.fn();
    render(<ModelPicker candidates={CANDIDATES} onPick={onPick} />);
    fireEvent.click(screen.getByText('Run default')); // trigger
    fireEvent.click(screen.getByText('GPT-5'));
    expect(onPick).toHaveBeenCalledWith('gpt-5', 'openai');
  });

  it('filters candidates by query', () => {
    render(<ModelPicker candidates={CANDIDATES} onPick={vi.fn()} />);
    fireEvent.click(screen.getByText('Run default'));
    fireEvent.change(screen.getByPlaceholderText('Filter models…'), { target: { value: 'opus' } });
    expect(screen.getByText('Claude Opus 4.8')).toBeTruthy();
    expect(screen.queryByText('GPT-5')).toBeNull();
  });

  it('shows + fires the reset row only when onReset is provided', () => {
    const onReset = vi.fn();
    const { rerender } = render(
      <ModelPicker
        candidates={CANDIDATES}
        value="gpt-5"
        provider="openai"
        onPick={vi.fn()}
        onReset={onReset}
      />,
    );
    fireEvent.click(screen.getByText('openai/gpt-5'));
    fireEvent.click(screen.getByText('Use run default'));
    expect(onReset).toHaveBeenCalled();

    rerender(<ModelPicker candidates={CANDIDATES} onPick={vi.fn()} />);
    fireEvent.click(screen.getByText('Run default'));
    expect(screen.queryByText('Use run default')).toBeNull();
  });
});

describe('FallbackEditor', () => {
  it('removes an entry without mutating the others', () => {
    const onChange = vi.fn();
    render(
      <FallbackEditor
        value={['anthropic/claude-opus-4-8', 'openai/gpt-5']}
        candidates={CANDIDATES}
        onChange={onChange}
      />,
    );
    // Two remove buttons (title="Remove"); click the first one.
    const removes = screen.getAllByTitle('Remove');
    fireEvent.click(removes[0]!);
    expect(onChange).toHaveBeenCalledWith(['openai/gpt-5']);
  });

  it('reorders an entry up', () => {
    const onChange = vi.fn();
    render(
      <FallbackEditor
        value={['anthropic/claude-opus-4-8', 'openai/gpt-5']}
        candidates={CANDIDATES}
        onChange={onChange}
      />,
    );
    const ups = screen.getAllByTitle('Move up');
    fireEvent.click(ups[1]!); // move the 2nd entry up
    expect(onChange).toHaveBeenCalledWith(['openai/gpt-5', 'anthropic/claude-opus-4-8']);
  });

  it('adds a picked model as a provider/model ref', () => {
    const onChange = vi.fn();
    render(<FallbackEditor value={[]} candidates={CANDIDATES} onChange={onChange} />);
    fireEvent.click(screen.getByText('Add a fallback model…'));
    fireEvent.click(screen.getByText('GPT-5'));
    expect(onChange).toHaveBeenCalledWith(['openai/gpt-5']);
  });
});

function makeTask(over: Partial<BoardTaskItem> = {}): BoardTaskItem {
  return {
    id: 'task-1',
    shortId: 't01',
    title: 'Build the thing',
    description: 'do it',
    priority: 'high',
    type: 'feature',
    status: 'pending',
    displayStatus: 'pending',
    deps: [],
    ...over,
  } as BoardTaskItem;
}

const noop = () => {};

describe('SddTaskDrawer controls', () => {
  const baseProps = {
    allTasks: [],
    feed: [],
    now: Date.now(),
    modelCandidates: CANDIDATES,
    onClose: noop,
    onRetry: noop,
    onReassign: noop,
    onSplit: noop,
    onSelectTask: noop,
  };

  it('Stop (running task) requires inline confirm, then fires onCancel', () => {
    const onCancel = vi.fn();
    render(
      <SddTaskDrawer
        {...baseProps}
        task={makeTask({ status: 'in_progress', displayStatus: 'in_progress' })}
        onSetModel={noop}
        onCancel={onCancel}
        onDelete={noop}
      />,
    );
    fireEvent.click(screen.getByText('Stop'));
    expect(onCancel).not.toHaveBeenCalled(); // confirm gate, no native dialog
    expect(screen.getByText('Stop this running task?')).toBeTruthy();
    fireEvent.click(screen.getByText('Stop', { selector: 'button' }));
    expect(onCancel).toHaveBeenCalledWith('task-1');
  });

  it('Delete (not-started task) confirms then fires onDelete', () => {
    const onDelete = vi.fn();
    render(
      <SddTaskDrawer
        {...baseProps}
        task={makeTask()}
        onSetModel={noop}
        onCancel={noop}
        onDelete={onDelete}
      />,
    );
    fireEvent.click(screen.getByText('Delete'));
    fireEvent.click(screen.getByText('Delete', { selector: 'button' }));
    expect(onDelete).toHaveBeenCalledWith('task-1');
  });

  it('Split parses the textarea into sub-tasks and fires onSplit', () => {
    const onSplit = vi.fn();
    render(
      <SddTaskDrawer
        {...baseProps}
        task={makeTask()}
        onSetModel={noop}
        onCancel={noop}
        onDelete={noop}
        onSplit={onSplit}
      />,
    );
    fireEvent.click(screen.getByText('Split'));
    const box = screen.getByPlaceholderText(/add the repository/i);
    fireEvent.change(box, { target: { value: 'Data layer :: build the repo\nWire the UI' } });
    fireEvent.click(screen.getByText('Split into sub-tasks'));
    expect(onSplit).toHaveBeenCalledWith('task-1', [
      { title: 'Data layer', description: 'build the repo' },
      { title: 'Wire the UI', description: 'Wire the UI' },
    ]);
  });

  it('does not offer Split on a running task', () => {
    render(
      <SddTaskDrawer
        {...baseProps}
        task={makeTask({ status: 'in_progress', displayStatus: 'in_progress' })}
        onSetModel={noop}
        onCancel={noop}
        onDelete={noop}
      />,
    );
    expect(screen.queryByText('Split')).toBeNull();
  });

  it('does not offer Stop on a pending task or Delete on a running task', () => {
    const { rerender } = render(
      <SddTaskDrawer
        {...baseProps}
        task={makeTask()}
        onSetModel={noop}
        onCancel={noop}
        onDelete={noop}
      />,
    );
    expect(screen.queryByText('Stop')).toBeNull();
    expect(screen.getByText('Delete')).toBeTruthy();

    rerender(
      <SddTaskDrawer
        {...baseProps}
        task={makeTask({ status: 'in_progress', displayStatus: 'in_progress' })}
        onSetModel={noop}
        onCancel={noop}
        onDelete={noop}
      />,
    );
    expect(screen.getByText('Stop')).toBeTruthy();
    expect(screen.queryByText('Delete')).toBeNull();
  });

  it('assigns a per-task model via the picker', () => {
    const onSetModel = vi.fn();
    render(
      <SddTaskDrawer
        {...baseProps}
        task={makeTask()}
        onSetModel={onSetModel}
        onCancel={noop}
        onDelete={noop}
      />,
    );
    // The drawer's ModelPicker trigger shows the run-default placeholder.
    fireEvent.click(screen.getByText('Run default'));
    fireEvent.click(screen.getByText('Claude Opus 4.8'));
    expect(onSetModel).toHaveBeenCalledWith('task-1', 'claude-opus-4-8', 'anthropic');
  });

  it('offers an expand control and renders structured task events', () => {
    const onToggleExpanded = vi.fn();
    render(
      <SddTaskDrawer
        {...baseProps}
        task={makeTask()}
        expanded
        feed={[
          {
            ts: Date.now(),
            kind: 'file',
            taskId: 'task-1',
            taskShortId: 't01',
            agentName: 'Ada',
            action: 'update',
            filePath: 'src/app.ts',
            text: 'update src/app.ts',
          },
          {
            ts: Date.now() - 10,
            kind: 'tool',
            taskId: 'task-1',
            taskShortId: 't01',
            action: 'shell_command',
            detail: 'pnpm test',
            durationMs: 1200,
            ok: true,
            text: 'ran shell_command',
          },
        ]}
        onToggleExpanded={onToggleExpanded}
        onSetModel={noop}
        onCancel={noop}
        onDelete={noop}
      />,
    );

    fireEvent.click(screen.getByLabelText('Collapse task details'));
    expect(onToggleExpanded).toHaveBeenCalledOnce();
    expect(screen.getByText('Task event log')).toBeTruthy();
    expect(screen.getByText('src/app.ts')).toBeTruthy();
    expect(screen.getByText('pnpm test')).toBeTruthy();
    expect(screen.getByText('1.2s')).toBeTruthy();
  });
});
