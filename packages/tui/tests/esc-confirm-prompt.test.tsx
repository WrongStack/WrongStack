import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { EscConfirmPrompt } from '../src/components/esc-confirm-prompt.js';

describe('EscConfirmPrompt', () => {
  it('renders the interrupt header', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { lastFrame, unmount } = render(
      React.createElement(EscConfirmPrompt, {
        runningTools: ['read'],
        subagentCount: 0,
        onConfirm,
        onCancel,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Interrupt the current run?');
    unmount();
  });

  it('shows tool name when exactly 1 running tool', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EscConfirmPrompt, {
        runningTools: ['read'],
        subagentCount: 0,
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('(read)');
    unmount();
  });

  it('shows tool count when multiple tools running', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EscConfirmPrompt, {
        runningTools: ['read', 'write', 'grep'],
        subagentCount: 0,
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('(3 tools)');
    unmount();
  });

  it('shows subagent count when active', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EscConfirmPrompt, {
        runningTools: [],
        subagentCount: 2,
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('2 subagents active');
    unmount();
  });

  it('shows singular subagent count when 1', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EscConfirmPrompt, {
        runningTools: [],
        subagentCount: 1,
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('1 subagent active');
    unmount();
  });

  it('shows [y]es and [n]o key hints', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EscConfirmPrompt, {
        runningTools: ['read'],
        subagentCount: 0,
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('[y]');
    expect(frame).toContain('[n]');
    expect(frame).toContain('stop and steer');
    expect(frame).toContain('keep running');
    unmount();
  });

  it('shows empty running tool label when tools array is empty', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EscConfirmPrompt, {
        runningTools: [],
        subagentCount: 0,
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    const frame = lastFrame() ?? '';
    // Should not show a tool hint when no tools
    expect(frame).toContain('The agent is working');
    unmount();
  });

  it('does not show subagent section when count is 0', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EscConfirmPrompt, {
        runningTools: ['read'],
        subagentCount: 0,
        onConfirm: vi.fn(),
        onCancel: vi.fn(),
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('subagents');
    expect(frame).not.toContain('subagent');
    unmount();
  });

  // ── Keyboard interaction tests ──────────────────────────────────────────

  it('pressing y calls onConfirm', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(EscConfirmPrompt, {
        runningTools: ['read'],
        subagentCount: 0,
        onConfirm,
        onCancel,
      }),
    );
    stdin.write('y');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onConfirm).toHaveBeenCalledOnce();
    expect(onCancel).not.toHaveBeenCalled();
    unmount();
  });

  it('pressing Y (uppercase) calls onConfirm', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(EscConfirmPrompt, {
        runningTools: ['read'],
        subagentCount: 0,
        onConfirm,
        onCancel,
      }),
    );
    stdin.write('Y');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onConfirm).toHaveBeenCalledOnce();
    unmount();
  });

  it('Ctrl+Y does not confirm the interrupt', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(EscConfirmPrompt, {
        runningTools: ['read'],
        subagentCount: 0,
        onConfirm,
        onCancel,
      }),
    );
    stdin.write('\x19');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    unmount();
  });

  it('pressing Enter calls onConfirm', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(EscConfirmPrompt, {
        runningTools: ['read'],
        subagentCount: 0,
        onConfirm,
        onCancel,
      }),
    );
    stdin.write('\r');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onConfirm).toHaveBeenCalledOnce();
    unmount();
  });

  it('pressing n calls onCancel', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(EscConfirmPrompt, {
        runningTools: ['read'],
        subagentCount: 0,
        onConfirm,
        onCancel,
      }),
    );
    stdin.write('n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onConfirm).not.toHaveBeenCalled();
    unmount();
  });

  it('unknown keys do not trigger callbacks', async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(EscConfirmPrompt, {
        runningTools: ['read'],
        subagentCount: 0,
        onConfirm,
        onCancel,
      }),
    );
    stdin.write('x');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).not.toHaveBeenCalled();
    unmount();
  });
});
