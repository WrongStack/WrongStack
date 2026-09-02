import { describe, expect, it } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ShadowPanel, type ShadowState } from '../src/components/shadow-panel.js';

describe('ShadowPanel', () => {
  const runningShadow: ShadowState = {
    activeId: 'shadow-abc123',
    running: true,
    model: 'deepseek-chat',
    intervalMs: 5000,
  };

  const stoppedShadow: ShadowState = {
    activeId: null,
    running: false,
    model: 'claude-haiku',
    intervalMs: 10000,
  };

  it('renders the header', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ShadowPanel, { shadow: runningShadow }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Shadow Agent');
    unmount();
  });

  it('shows running status with green LED', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ShadowPanel, { shadow: runningShadow }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('● running');
    // Id is truncated to 12 chars + '…' by the component
    expect(frame).toContain('shadow-abc12');
    unmount();
  });

  it('shows stopped status with gray LED', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ShadowPanel, { shadow: stoppedShadow }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('○ stopped');
    unmount();
  });

  it('displays the model name', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ShadowPanel, { shadow: runningShadow }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('deepseek-chat');
    unmount();
  });

  it('formats interval in seconds when >= 1000ms', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ShadowPanel, { shadow: runningShadow }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('5s');
    unmount();
  });

  it('formats interval in ms when < 1000ms', () => {
    const shortShadow: ShadowState = {
      activeId: null,
      running: false,
      model: 'gpt-4o',
      intervalMs: 500,
    };
    const { lastFrame, unmount } = render(
      React.createElement(ShadowPanel, { shadow: shortShadow }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('500ms');
    unmount();
  });

  it('shows start hint when stopped', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ShadowPanel, { shadow: stoppedShadow }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Press s to start');
    unmount();
  });

  it('shows stop hint when running', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ShadowPanel, { shadow: runningShadow }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Press t to stop');
    unmount();
  });

  it('does not show activeId when null', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ShadowPanel, { shadow: stoppedShadow }),
    );
    const frame = lastFrame() ?? '';
    // The active id should not appear (just stopping text)
    expect(frame).not.toContain('…');
    unmount();
  });

  it('renders hint text when provided', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ShadowPanel, {
        shadow: runningShadow,
        hint: 'Press Esc to close',
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Press Esc to close');
    unmount();
  });

  it('does not render hint section when hint is undefined', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ShadowPanel, { shadow: runningShadow }),
    );
    const frame = lastFrame() ?? '';
    // Should not hint about pressing Esc to close without hint prop
    expect(frame).toContain('Shadow Agent');
    unmount();
  });

  it('shows min 5s note in interval line', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ShadowPanel, { shadow: runningShadow }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('min 5s');
    unmount();
  });

  it('handles shadow with very long activeId', () => {
    const longId = 'a'.repeat(36);
    const shadow: ShadowState = {
      activeId: longId,
      running: true,
      model: 'test',
      intervalMs: 5000,
    };
    const { lastFrame, unmount } = render(React.createElement(ShadowPanel, { shadow }));
    const frame = lastFrame() ?? '';
    // Should truncate to 12 chars + …
    expect(frame).toContain(longId.slice(0, 12));
    expect(frame).toContain('…');
    unmount();
  });

  it('shows keyboard shortcuts legend', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ShadowPanel, { shadow: runningShadow }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('s start');
    expect(frame).toContain('t stop');
    expect(frame).toContain('i cycle interval');
    expect(frame).toContain('m cycle model');
    expect(frame).toContain('Esc close');
    unmount();
  });
});
