import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { CheckpointTimeline } from '../src/components/checkpoint-timeline.js';

describe('CheckpointTimeline', () => {
  const checkpoints = [
    {
      promptIndex: 0,
      promptPreview: 'Initial prompt',
      ts: '2026-07-19T10:00:00.000Z',
      fileCount: 0,
    },
    {
      promptIndex: 1,
      promptPreview: 'Second iteration',
      ts: '2026-07-19T10:05:00.000Z',
      fileCount: 3,
    },
    {
      promptIndex: 2,
      promptPreview: 'Third step with more context',
      ts: '2026-07-19T10:10:00.000Z',
      fileCount: 1,
    },
  ];

  it('renders the header', () => {
    const { lastFrame, unmount } = render(
      React.createElement(CheckpointTimeline, {
        checkpoints,
        selected: 0,
        onSelect: vi.fn(),
        onConfirm: vi.fn(),
        onClose: vi.fn(),
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Session Rewind');
    unmount();
  });

  it('shows navigation key hints', () => {
    const { lastFrame, unmount } = render(
      React.createElement(CheckpointTimeline, {
        checkpoints,
        selected: 0,
        onSelect: vi.fn(),
        onConfirm: vi.fn(),
        onClose: vi.fn(),
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('↑/↓ navigate');
    expect(frame).toContain('Enter rewind');
    expect(frame).toContain('Esc cancel');
    unmount();
  });

  it('shows empty state when no checkpoints', () => {
    const { lastFrame, unmount } = render(
      React.createElement(CheckpointTimeline, {
        checkpoints: [],
        selected: 0,
        onSelect: vi.fn(),
        onConfirm: vi.fn(),
        onClose: vi.fn(),
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('No checkpoints in this session.');
    unmount();
  });

  it('renders all checkpoint entries with prompt index', () => {
    const { lastFrame, unmount } = render(
      React.createElement(CheckpointTimeline, {
        checkpoints,
        selected: 0,
        onSelect: vi.fn(),
        onConfirm: vi.fn(),
        onClose: vi.fn(),
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('[0]');
    expect(frame).toContain('[1]');
    expect(frame).toContain('[2]');
    expect(frame).toContain('Initial prompt');
    expect(frame).toContain('Second iteration');
    unmount();
  });

  it('marks the selected checkpoint with ▸ ', () => {
    const { lastFrame, unmount } = render(
      React.createElement(CheckpointTimeline, {
        checkpoints,
        selected: 1,
        onSelect: vi.fn(),
        onConfirm: vi.fn(),
        onClose: vi.fn(),
      } as never),
    );
    const frame = lastFrame() ?? '';
    // Only one ▸ should be visible
    const arrowCount = (frame.match(/▸/g) ?? []).length;
    expect(arrowCount).toBe(1);
    unmount();
  });

  it('shows file count when > 0 (plural)', () => {
    const { lastFrame, unmount } = render(
      React.createElement(CheckpointTimeline, {
        checkpoints: [checkpoints[1]],
        selected: 0,
        onSelect: vi.fn(),
        onConfirm: vi.fn(),
        onClose: vi.fn(),
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('3 files');
    unmount();
  });

  it('shows file count when === 1 (singular)', () => {
    const { lastFrame, unmount } = render(
      React.createElement(CheckpointTimeline, {
        checkpoints: [checkpoints[2]],
        selected: 0,
        onSelect: vi.fn(),
        onConfirm: vi.fn(),
        onClose: vi.fn(),
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1 file');
    unmount();
  });

  it('does not show file section when fileCount is 0', () => {
    const { lastFrame, unmount } = render(
      React.createElement(CheckpointTimeline, {
        checkpoints: [checkpoints[0]],
        selected: 0,
        onSelect: vi.fn(),
        onConfirm: vi.fn(),
        onClose: vi.fn(),
      } as never),
    );
    const frame = lastFrame() ?? '';
    // Should not show "0 files"
    expect(frame).not.toContain('0 file');
    unmount();
  });

  it('handles checkpoint with very long prompt preview', () => {
    const longPreview = 'A'.repeat(100);
    const { lastFrame, unmount } = render(
      React.createElement(CheckpointTimeline, {
        checkpoints: [
          {
            promptIndex: 5,
            promptPreview: longPreview,
            ts: '2026-07-19T12:00:00.000Z',
            fileCount: 0,
          },
        ],
        selected: 0,
        onSelect: vi.fn(),
        onConfirm: vi.fn(),
        onClose: vi.fn(),
      } as never),
    );
    const frame = lastFrame() ?? '';
    // Long previews may wrap across lines in the terminal box
    expect(frame).toContain('[5]');
    expect(frame).toContain('AAAAA');
    unmount();
  });

  it('renders with selected at the last checkpoint', () => {
    const { lastFrame, unmount } = render(
      React.createElement(CheckpointTimeline, {
        checkpoints,
        selected: 2,
        onSelect: vi.fn(),
        onConfirm: vi.fn(),
        onClose: vi.fn(),
      } as never),
    );
    const frame = lastFrame() ?? '';
    // Last checkpoint should be selected
    expect(frame).toContain('Third step');
    unmount();
  });

  // ── Keyboard interaction tests ──────────────────────────────────────────

  it('pressing down arrow calls onSelect with next index', async () => {
    const onSelect = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(CheckpointTimeline, {
        checkpoints,
        selected: 1,
        onSelect,
        onConfirm: vi.fn(),
        onClose: vi.fn(),
      } as never),
    );
    stdin.write('\x1b[B');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onSelect).toHaveBeenCalledWith(2);
    unmount();
  });

  it('pressing down arrow at last index calls onSelect with last index', async () => {
    const onSelect = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(CheckpointTimeline, {
        checkpoints,
        selected: 2,
        onSelect,
        onConfirm: vi.fn(),
        onClose: vi.fn(),
      } as never),
    );
    stdin.write('\x1b[B');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onSelect).toHaveBeenCalledWith(2);
    unmount();
  });

  it('pressing up arrow calls onSelect with prev index', async () => {
    const onSelect = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(CheckpointTimeline, {
        checkpoints,
        selected: 1,
        onSelect,
        onConfirm: vi.fn(),
        onClose: vi.fn(),
      } as never),
    );
    stdin.write('\x1b[A');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onSelect).toHaveBeenCalledWith(0);
    unmount();
  });

  it('pressing up arrow at first index clamps to 0', async () => {
    const onSelect = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(CheckpointTimeline, {
        checkpoints,
        selected: 0,
        onSelect,
        onConfirm: vi.fn(),
        onClose: vi.fn(),
      } as never),
    );
    stdin.write('\x1b[A');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onSelect).toHaveBeenCalledWith(0);
    unmount();
  });

  it('pressing Enter calls onConfirm with selected index', async () => {
    const onConfirm = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(CheckpointTimeline, {
        checkpoints,
        selected: 1,
        onSelect: vi.fn(),
        onConfirm,
        onClose: vi.fn(),
      } as never),
    );
    stdin.write('\r');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onConfirm).toHaveBeenCalledWith(1);
    unmount();
  });
});
