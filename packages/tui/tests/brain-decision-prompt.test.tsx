import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import {
  BrainDecisionPrompt,
  type BrainDecisionPromptOption,
} from '../src/components/brain-decision-prompt.js';

describe('BrainDecisionPrompt', () => {
  const options: BrainDecisionPromptOption[] = [
    { id: 'opt_1', label: 'Proceed with caution', risk: 'medium', consequence: 'May take longer' },
    { id: 'opt_2', label: 'Use alternative approach', risk: 'low', recommended: true },
    { id: 'opt_3', label: 'Abort operation', risk: 'high', consequence: 'Loses progress' },
  ];

  it('renders the heading and source/risk', () => {
    const { lastFrame, unmount } = render(
      React.createElement(BrainDecisionPrompt, {
        requestId: 'req_001',
        source: 'autonomy-engine',
        risk: 'high',
        question: 'Should we proceed with the refactor?',
        options,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('BRAIN REQUIRES HUMAN DECISION');
    expect(frame).toContain('autonomy-engine');
    expect(frame).toContain('high');
    unmount();
  });

  it('renders the question text', () => {
    const { lastFrame, unmount } = render(
      React.createElement(BrainDecisionPrompt, {
        requestId: 'req_001',
        source: 'test',
        risk: 'medium',
        question: 'Should we proceed?',
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Should we proceed?');
    unmount();
  });

  it('renders options with keys A, B, C', () => {
    const { lastFrame, unmount } = render(
      React.createElement(BrainDecisionPrompt, {
        requestId: 'req_001',
        source: 'test',
        risk: 'medium',
        question: 'Which path?',
        options,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('[A]');
    expect(frame).toContain('[B]');
    expect(frame).toContain('[C]');
    expect(frame).toContain('Proceed with caution');
    expect(frame).toContain('Use alternative approach');
    expect(frame).toContain('Abort operation');
    unmount();
  });

  it('marks recommended options', () => {
    const { lastFrame, unmount } = render(
      React.createElement(BrainDecisionPrompt, {
        requestId: 'req_001',
        source: 'test',
        risk: 'low',
        question: 'Which path?',
        options,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('recommended');
    unmount();
  });

  it('shows option consequences', () => {
    const { lastFrame, unmount } = render(
      React.createElement(BrainDecisionPrompt, {
        requestId: 'req_001',
        source: 'test',
        risk: 'medium',
        question: 'Which path?',
        options,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('May take longer');
    expect(frame).toContain('Loses progress');
    unmount();
  });

  it('uses risk-color mapping: low→green text', () => {
    const { lastFrame, unmount } = render(
      React.createElement(BrainDecisionPrompt, {
        requestId: 'req_001',
        source: 'test',
        risk: 'low',
        question: 'Low risk?',
        options: [{ id: 'safe', label: 'Safe option', risk: 'low' }],
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Safe option');
    unmount();
  });

  it('uses risk-color mapping: critical→red', () => {
    const { lastFrame, unmount } = render(
      React.createElement(BrainDecisionPrompt, {
        requestId: 'req_001',
        source: 'test',
        risk: 'critical',
        question: 'Critical!',
        options: [{ id: 'crit', label: 'Critical option', risk: 'critical' }],
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Critical option');
    unmount();
  });

  it('uses risk-color mapping: unknown risk→white', () => {
    const { lastFrame, unmount } = render(
      React.createElement(BrainDecisionPrompt, {
        requestId: 'req_001',
        source: 'test',
        risk: 'unknown-level' as any,
        question: 'Unknown?',
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Unknown?');
    unmount();
  });

  it('renders context lines when provided', () => {
    const { lastFrame, unmount } = render(
      React.createElement(BrainDecisionPrompt, {
        requestId: 'req_001',
        source: 'test',
        risk: 'medium',
        question: 'Context test?',
        context: 'Line one\nLine two\nLine three\nLine four\nLine five',
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Line one');
    expect(frame).toContain('Line five');
    unmount();
  });

  it('truncates context to 5 lines', () => {
    const { lastFrame, unmount } = render(
      React.createElement(BrainDecisionPrompt, {
        requestId: 'req_001',
        source: 'test',
        risk: 'low',
        question: 'Long context?',
        context: '1\n2\n3\n4\n5\n6\n7',
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toMatch(/…|more/);
    expect(frame).not.toContain('6');
    unmount();
  });

  it('does not render context section when context is empty', () => {
    const { lastFrame, unmount } = render(
      React.createElement(BrainDecisionPrompt, {
        requestId: 'req_001',
        source: 'test',
        risk: 'low',
        question: 'No context?',
        context: '',
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('No context?');
    // Context section should not be there
    expect(frame).not.toContain('Context:');
    unmount();
  });

  it('does not render context when context is only whitespace', () => {
    const { lastFrame, unmount } = render(
      React.createElement(BrainDecisionPrompt, {
        requestId: 'req_001',
        source: 'test',
        risk: 'low',
        question: 'Whitespace?',
        context: '   \n  ',
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('Context:');
    unmount();
  });

  it('does not render options section when options is empty', () => {
    const { lastFrame, unmount } = render(
      React.createElement(BrainDecisionPrompt, {
        requestId: 'req_001',
        source: 'test',
        risk: 'low',
        question: 'No options?',
        options: [],
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('[A]');
    unmount();
  });

  it('limits displayed options to 6', () => {
    const manyOptions: BrainDecisionPromptOption[] = Array.from({ length: 8 }, (_, i) => ({
      id: `opt_${i}`,
      label: `Option ${i}`,
    }));
    const { lastFrame, unmount } = render(
      React.createElement(BrainDecisionPrompt, {
        requestId: 'req_001',
        source: 'test',
        risk: 'medium',
        question: 'Many options?',
        options: manyOptions,
      }),
    );
    const frame = lastFrame() ?? '';
    // Should show [A] through [F] (6 options)
    // Option 6 should not appear
    expect(frame).toContain('[F]');
    expect(frame).toContain('Option 5');
    expect(frame).not.toContain('Option 6');
    expect(frame).not.toContain('Option 7');
    unmount();
  });

  it('shows footer key hints', () => {
    const { lastFrame, unmount } = render(
      React.createElement(BrainDecisionPrompt, {
        requestId: 'req_001',
        source: 'test',
        risk: 'low',
        question: 'Hints?',
        options,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Press A/B/C or 1/2/3 to answer');
    expect(frame).toContain('Esc or D denies with the safe default');
    unmount();
  });

  it('handles option with undefined risk (falls back to parent risk)', () => {
    const { lastFrame, unmount } = render(
      React.createElement(BrainDecisionPrompt, {
        requestId: 'req_001',
        source: 'test',
        risk: 'medium',
        question: 'Fallback risk?',
        options: [{ id: 'no-risk', label: 'No risk specified' }],
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('No risk specified');
    unmount();
  });

  // ── Keyboard interaction tests ──────────────────────────────────────────

  it('pressing A selects the first option', async () => {
    const onAnswer = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(BrainDecisionPrompt, {
        requestId: 'req_001',
        source: 'test',
        risk: 'low',
        question: 'Which?',
        options,
        onAnswer,
      }),
    );
    stdin.write('a');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onAnswer).toHaveBeenCalledWith({
      id: 'req_001',
      optionId: 'opt_1',
      text: 'Proceed with caution',
    });
    unmount();
  });

  it('pressing B selects the second option', async () => {
    const onAnswer = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(BrainDecisionPrompt, {
        requestId: 'req_002',
        source: 'test',
        risk: 'medium',
        question: 'Which?',
        options,
        onAnswer,
      }),
    );
    stdin.write('b');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onAnswer).toHaveBeenCalledWith({
      id: 'req_002',
      optionId: 'opt_2',
      text: 'Use alternative approach',
    });
    unmount();
  });

  it('pressing 1 selects the first option', async () => {
    const onAnswer = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(BrainDecisionPrompt, {
        requestId: 'req_003',
        source: 'test',
        risk: 'medium',
        question: 'Which?',
        options,
        onAnswer,
      }),
    );
    stdin.write('1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onAnswer).toHaveBeenCalledWith({
      id: 'req_003',
      optionId: 'opt_1',
      text: 'Proceed with caution',
    });
    unmount();
  });

  it('pressing D denies with safe default', async () => {
    const onAnswer = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(BrainDecisionPrompt, {
        requestId: 'req_005',
        source: 'test',
        risk: 'critical',
        question: 'Emergency?',
        options,
        onAnswer,
      }),
    );
    stdin.write('d');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onAnswer).toHaveBeenCalledWith({
      id: 'req_005',
      deny: true,
      text: 'Denied by human from TUI.',
    });
    unmount();
  });

  it('pressing an unknown letter does not call onAnswer', async () => {
    const onAnswer = vi.fn();
    const { stdin, unmount } = render(
      React.createElement(BrainDecisionPrompt, {
        requestId: 'req_006',
        source: 'test',
        risk: 'low',
        question: 'Ignore?',
        options,
        onAnswer,
      }),
    );
    stdin.write('z');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onAnswer).not.toHaveBeenCalled();
    unmount();
  });

  it('does not process keystrokes when onAnswer is undefined', async () => {
    const { stdin, unmount } = render(
      React.createElement(BrainDecisionPrompt, {
        requestId: 'req_007',
        source: 'test',
        risk: 'low',
        question: 'No handler?',
        options,
      }),
    );
    // Should not throw
    stdin.write('a');
    await new Promise((resolve) => setImmediate(resolve));
    unmount();
  });
});
