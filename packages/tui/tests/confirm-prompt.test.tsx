import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmPrompt, confirmButtonSegments } from '../src/components/confirm-prompt.js';

// writeOut is called on mount but module resolution for @wrongstack/core
// is complex due to the workspace alias; tested via keyboard interactions below.

// Mock the highlight module to avoid dynamic import issues
vi.mock('../src/highlight.js', () => ({
  langFromPath: () => 'typescript',
}));

// Mock code-block to avoid complex render
vi.mock('../src/components/history/code-block.js', () => ({
  parseUnifiedDiff: () => ({
    rows: [],
    hidden: 0,
    added: 0,
    removed: 0,
    hiddenAdded: 0,
    hiddenRemoved: 0,
  }),
  DiffBlock: () => null,
}));

describe('confirmButtonSegments', () => {
  it('calculates segments correctly', () => {
    const segments = confirmButtonSegments('');
    expect(segments).toHaveLength(6);
    expect(segments[0]!.decision).toBe('yes');
    expect(segments[0]!.start).toBe(0);
    expect(segments[1]!.decision).toBe('no');
    expect(segments[2]!.decision).toBe('always-exact');
    expect(segments[5]!.decision).toBe('deny');
  });

  it('includes suggested pattern in always segment', () => {
    const segments = confirmButtonSegments('rm -rf');
    const always = segments.find((s) => s.decision === 'always-exact')!;
    expect(always.len).toBeGreaterThan(10);
  });

  it('segments are contiguous', () => {
    const segments = confirmButtonSegments('test');
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]!.start).toBe(segments[i - 1]!.start + segments[i - 1]!.len);
    }
  });

  it('empty suggested pattern does not break segments', () => {
    const segments = confirmButtonSegments('');
    expect(segments.length).toBe(6);
    segments.forEach((s) => {
      expect(s.len).toBeGreaterThan(0);
    });
  });
});

describe('ConfirmPrompt', () => {
  it('renders the approval header with tool name', () => {
    const view = render(
      React.createElement(ConfirmPrompt, {
        toolName: 'bash',
        input: { command: 'ls' },
        suggestedPattern: 'bash',
        onDecision: vi.fn(),
        onEnableYolo: vi.fn(),
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('APPROVAL REQUIRED');
    expect(frame).toContain('bash');
    view.unmount();
  });

  it('renders the input summary', () => {
    const view = render(
      React.createElement(ConfirmPrompt, {
        toolName: 'read',
        input: { path: '/tmp/test.txt' },
        suggestedPattern: 'read',
        onDecision: vi.fn(),
        onEnableYolo: vi.fn(),
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('path:');
    view.unmount();
  });

  it('strips bidi overrides and invisible text from the summary and write targets', () => {
    // JSON escaping leaves U+202E and tag characters raw; the dialog showed a
    // reordered command / hidden text to the user approving it.
    const view = render(
      React.createElement(ConfirmPrompt, {
        toolName: 'write',
        input: { command: `cat notes‮txt.hs${String.fromCodePoint(0xe0041)}` },
        writeTargets: ['r‮gnp.exe'],
        suggestedPattern: 'write',
        onDecision: vi.fn(),
        onEnableYolo: vi.fn(),
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('cat notestxt.hs');
    expect(frame).toContain('WRITES: rgnp.exe');
    expect(frame).not.toMatch(/[\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/u);
    view.unmount();
  });

  it('renders button labels with [y], [n], [a], [d]', () => {
    const view = render(
      React.createElement(ConfirmPrompt, {
        toolName: 'bash',
        input: {},
        suggestedPattern: 'bash',
        onDecision: vi.fn(),
        onEnableYolo: vi.fn(),
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('[y]');
    expect(frame).toContain('[n]');
    expect(frame).toContain('[a]');
    expect(frame).toContain('[d]');
    view.unmount();
  });

  it('calls onDecision with "yes" on "y" keypress', () => {
    const onDecision = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(ConfirmPrompt, {
        toolName: 'bash',
        input: {},
        suggestedPattern: 'bash',
        onDecision,
        onEnableYolo: vi.fn(),
      }),
    );
    stdin.write('y');
    expect(onDecision).toHaveBeenCalledWith('yes');
    unmount();
  });

  it('calls onDecision with "no" on "n" keypress', () => {
    const onDecision = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(ConfirmPrompt, {
        toolName: 'bash',
        input: {},
        suggestedPattern: 'bash',
        onDecision,
        onEnableYolo: vi.fn(),
      }),
    );
    stdin.write('n');
    expect(onDecision).toHaveBeenCalledWith('no');
    unmount();
  });

  it('calls onDecision with "always-exact" on "a" keypress', () => {
    const onDecision = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(ConfirmPrompt, {
        toolName: 'bash',
        input: {},
        suggestedPattern: 'bash',
        onDecision,
        onEnableYolo: vi.fn(),
      }),
    );
    stdin.write('a');
    expect(onDecision).toHaveBeenCalledWith('always-exact');
    unmount();
  });

  it('calls onDecision with "deny" on "d" keypress', () => {
    const onDecision = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(ConfirmPrompt, {
        toolName: 'bash',
        input: {},
        suggestedPattern: 'bash',
        onDecision,
        onEnableYolo: vi.fn(),
      }),
    );
    stdin.write('d');
    expect(onDecision).toHaveBeenCalledWith('deny');
    unmount();
  });

  it('calls onEnableYolo on capital "Y" keypress', () => {
    const onEnableYolo = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(ConfirmPrompt, {
        toolName: 'bash',
        input: {},
        suggestedPattern: 'bash',
        onDecision: vi.fn(),
        onEnableYolo,
      }),
    );
    stdin.write('Y');
    expect(onEnableYolo).toHaveBeenCalled();
    unmount();
  });

  it('does not call onEnableYolo when boundaryReason is set', () => {
    const onEnableYolo = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(ConfirmPrompt, {
        toolName: 'bash',
        input: {},
        suggestedPattern: 'bash',
        onDecision: vi.fn(),
        onEnableYolo,
        boundaryReason: 'test boundary',
      }),
    );
    stdin.write('Y');
    expect(onEnableYolo).not.toHaveBeenCalled();
    unmount();
  });

  it('ignores Enter and arrow keys', () => {
    const onDecision = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(ConfirmPrompt, {
        toolName: 'bash',
        input: {},
        suggestedPattern: 'bash',
        onDecision,
        onEnableYolo: vi.fn(),
      }),
    );
    stdin.write('\r');
    expect(onDecision).not.toHaveBeenCalled();
    stdin.write('\n');
    expect(onDecision).not.toHaveBeenCalled();
    unmount();
  });

  it('renders boundary reason when provided', () => {
    const view = render(
      React.createElement(ConfirmPrompt, {
        toolName: 'edit',
        input: {},
        suggestedPattern: 'edit',
        onDecision: vi.fn(),
        onEnableYolo: vi.fn(),
        boundaryReason: 'cross-boundary edit',
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('KANBAN BOUNDARY');
    expect(frame).toContain('cross-boundary edit');
    view.unmount();
  });

  it('does not show YOLO tip when boundaryReason is set', () => {
    const view = render(
      React.createElement(ConfirmPrompt, {
        toolName: 'edit',
        input: {},
        suggestedPattern: 'edit',
        onDecision: vi.fn(),
        onEnableYolo: vi.fn(),
        boundaryReason: 'test',
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).not.toContain('YOLO');
    view.unmount();
  });

  it('capital Y does not approve a boundary-protected call', async () => {
    const onDecision = vi.fn();
    const onEnableYolo = vi.fn();
    const view = render(
      React.createElement(ConfirmPrompt, {
        toolName: 'bash',
        input: { command: 'rm -rf ./build' },
        suggestedPattern: 'bash',
        onDecision,
        onEnableYolo,
        destructive: true,
        boundaryReason: 'kanban boundary: locked',
      }),
    );
    try {
      expect(view.lastFrame()).toContain('KANBAN BOUNDARY');
      view.stdin.write('Y');
      await new Promise((resolve) => setImmediate(resolve));
      expect(onDecision).not.toHaveBeenCalled();
      expect(onEnableYolo).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });

  it('shows YOLO tip when no boundaryReason', () => {
    const view = render(
      React.createElement(ConfirmPrompt, {
        toolName: 'edit',
        input: {},
        suggestedPattern: 'edit',
        onDecision: vi.fn(),
        onEnableYolo: vi.fn(),
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('YOLO');
    view.unmount();
  });

  it('shows destructive hint in YOLO tip when destructive', () => {
    const view = render(
      React.createElement(ConfirmPrompt, {
        toolName: 'edit',
        input: {},
        suggestedPattern: 'edit',
        onDecision: vi.fn(),
        onEnableYolo: vi.fn(),
        destructive: true,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('this destructive approval remains');
    view.unmount();
  });

  it('shows non-destructive hint in YOLO tip', () => {
    const view = render(
      React.createElement(ConfirmPrompt, {
        toolName: 'read',
        input: {},
        suggestedPattern: 'read',
        onDecision: vi.fn(),
        onEnableYolo: vi.fn(),
        destructive: false,
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('skips future routine approvals');
    view.unmount();
  });

  it('renders diff when input has diff field', () => {
    const view = render(
      React.createElement(ConfirmPrompt, {
        toolName: 'edit',
        input: { diff: '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+new', path: 'test.ts' },
        suggestedPattern: 'edit',
        onDecision: vi.fn(),
        onEnableYolo: vi.fn(),
      }),
    );
    const frame = view.lastFrame() ?? '';
    // Should render something - but DiffBlock is mocked to null so no content assertion
    expect(frame).toContain('APPROVAL REQUIRED');
    view.unmount();
  });

  it('handles undefined/null input gracefully', () => {
    const view = render(
      React.createElement(ConfirmPrompt, {
        toolName: 'bash',
        input: undefined,
        suggestedPattern: 'bash',
        onDecision: vi.fn(),
        onEnableYolo: vi.fn(),
      }),
    );
    const frame = view.lastFrame() ?? '';
    expect(frame).toContain('APPROVAL REQUIRED');
    view.unmount();
  });
});

describe('approval modifier isolation', () => {
  it.each(['\x03', '\x19', '\x01', '\x14', '\x04', '\x1by'])(
    'does not grant or deny permission for modified input %j',
    (input) => {
      const onDecision = vi.fn();
      const onEnableYolo = vi.fn();
      const view = render(
        React.createElement(ConfirmPrompt, {
          toolName: 'exec',
          input: { command: 'echo test' },
          suggestedPattern: 'exec',
          onDecision,
          onEnableYolo,
        }),
      );
      try {
        view.stdin.write(input);
        expect(onDecision).not.toHaveBeenCalled();
        expect(onEnableYolo).not.toHaveBeenCalled();
      } finally {
        view.unmount();
      }
    },
  );
});
