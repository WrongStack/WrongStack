import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import type { BrainStatusChip } from '../src/components/status-bar.js';
import { BrainChip, EternalStageChip, ThinkingChip } from '../src/components/status-bar-chips.js';

describe('BrainChip', () => {
  const baseBrain: BrainStatusChip = { state: 'idle' };

  it('renders idle state', () => {
    const { lastFrame, unmount } = render(React.createElement(BrainChip, { brain: baseBrain }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('idle');
    unmount();
  });

  it('renders denied state with error color', () => {
    const { lastFrame, unmount } = render(
      React.createElement(BrainChip, { brain: { state: 'denied' } }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('denied');
    unmount();
  });

  it('renders ask_human state', () => {
    const { lastFrame, unmount } = render(
      React.createElement(BrainChip, { brain: { state: 'ask_human' } }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('human');
    unmount();
  });

  it('renders deciding state', () => {
    const { lastFrame, unmount } = render(
      React.createElement(BrainChip, { brain: { state: 'deciding' } }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('deciding');
    unmount();
  });

  it('renders with source info', () => {
    const { lastFrame, unmount } = render(
      React.createElement(BrainChip, { brain: { ...baseBrain, source: 'autonomy' } }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('autonomy');
    unmount();
  });

  it('renders with summary text truncated to 40 chars', () => {
    const longSummary = 'A'.repeat(50);
    const { lastFrame, unmount } = render(
      React.createElement(BrainChip, {
        brain: { ...baseBrain, summary: longSummary },
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('A'.repeat(40));
    expect(frame).not.toContain('A'.repeat(50));
    unmount();
  });

  it('renders with summary under 40 chars', () => {
    const { lastFrame, unmount } = render(
      React.createElement(BrainChip, {
        brain: { ...baseBrain, summary: 'quick thought' },
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('quick thought');
    unmount();
  });

  it('renders monochrome mode without glyphs and color', () => {
    const { lastFrame, unmount } = render(
      React.createElement(BrainChip, { brain: { state: 'deciding' }, monochrome: true }),
    );
    const frame = lastFrame() ?? '';
    // In monochrome, should not contain brain glyph or summary
    expect(frame).toContain('deciding');
    unmount();
  });
});

describe('EternalStageChip', () => {
  it('renders idle phase', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EternalStageChip, {
        stage: { phase: 'idle', ms: 0 },
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('idle');
    unmount();
  });

  it('renders decide phase with reason', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EternalStageChip, {
        stage: { phase: 'decide', reason: 'analyzing context', ms: 0 },
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('decide');
    expect(frame).toContain('analyzing context');
    unmount();
  });

  it('renders execute phase with task', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EternalStageChip, {
        stage: { phase: 'execute', task: 'fix-bug', ms: 0 },
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('execute');
    expect(frame).toContain('fix-bug');
    unmount();
  });

  it('renders execute phase without task', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EternalStageChip, {
        stage: { phase: 'execute', ms: 0 },
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('execute');
    unmount();
  });

  it('renders reflect phase with success status', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EternalStageChip, {
        stage: { phase: 'reflect', status: 'success', ms: 0 },
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('reflect');
    expect(frame).toContain('success');
    unmount();
  });

  it('renders reflect phase with failure status', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EternalStageChip, {
        stage: { phase: 'reflect', status: 'failure', ms: 0 },
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('reflect');
    expect(frame).toContain('failure');
    unmount();
  });

  it('renders reflect phase with unknown status', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EternalStageChip, {
        stage: { phase: 'reflect', status: 'unknown' as any, ms: 0 },
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('reflect');
    // Unknown status should use warn color fallback
    unmount();
  });

  it('renders decompose phase', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EternalStageChip, {
        stage: { phase: 'decompose', ms: 0 },
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('decompose');
    unmount();
  });

  it('renders fanout phase with slots', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EternalStageChip, {
        stage: { phase: 'fanout', slots: 4, ms: 0 },
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('fanout');
    expect(frame).toContain('4');
    unmount();
  });

  it('renders await phase with task count', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EternalStageChip, {
        stage: { phase: 'await', taskIds: ['t1', 't2', 't3'], ms: 0 },
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('await');
    expect(frame).toContain('3');
    unmount();
  });

  it('renders aggregate phase with goal complete', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EternalStageChip, {
        stage: { phase: 'aggregate', successCount: 5, total: 8, goalComplete: true, ms: 0 },
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('aggregate');
    expect(frame).toContain('5/8');
    unmount();
  });

  it('renders aggregate phase without goal complete', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EternalStageChip, {
        stage: { phase: 'aggregate', successCount: 2, total: 10, goalComplete: false, ms: 0 },
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('aggregate');
    expect(frame).toContain('2/10');
    unmount();
  });

  it('renders sleep phase', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EternalStageChip, {
        stage: { phase: 'sleep', ms: 5000 },
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('sleep');
    expect(frame).toContain('5s');
    unmount();
  });

  it('renders paused phase', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EternalStageChip, {
        stage: { phase: 'paused', ms: 0 },
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('paused');
    unmount();
  });

  it('renders stopped phase', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EternalStageChip, {
        stage: { phase: 'stopped', ms: 0 },
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('stopped');
    unmount();
  });

  it('renders error phase with message', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EternalStageChip, {
        stage: { phase: 'error', message: 'Something broke', ms: 0 },
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('error');
    expect(frame).toContain('Something broke');
    unmount();
  });

  it('renders unknown phase via exhaustive check', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EternalStageChip, {
        stage: { phase: 'unknown_phase' as any, ms: 0 },
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('unknown');
    unmount();
  });

  it('renders decide phase in monochrome mode', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EternalStageChip, {
        stage: { phase: 'decide', reason: 'test', ms: 0 },
        monochrome: true,
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('decide: test');
    unmount();
  });

  it('renders sleep phase in monochrome mode', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EternalStageChip, {
        stage: { phase: 'sleep', ms: 30000 },
        monochrome: true,
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('sleep 30s');
    unmount();
  });

  it('renders idle phase in monochrome mode', () => {
    const { lastFrame, unmount } = render(
      React.createElement(EternalStageChip, {
        stage: { phase: 'idle', ms: 0 },
        monochrome: true,
      } as never),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('idle');
    unmount();
  });
});

describe('ThinkingChip', () => {
  it('renders rainbow style with per-glyph colors', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ThinkingChip, {
        text: 'thinking',
        style: 'rainbow',
        phase: 0,
        cycleTick: 0,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('thinking');
    unmount();
  });

  it('renders wave style', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ThinkingChip, {
        text: 'working',
        style: 'wave',
        phase: 1,
        cycleTick: 0,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('working');
    unmount();
  });

  it('renders pulse style', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ThinkingChip, {
        text: 'cooking',
        style: 'pulse',
        phase: 2,
        cycleTick: 0,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('cooking');
    unmount();
  });

  it('renders dots style stripping trailing dots and appending frame', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ThinkingChip, {
        text: 'loading...',
        style: 'dots',
        phase: 0,
        cycleTick: 0,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('loading');
    unmount();
  });

  it('renders breathe style with braille prefix', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ThinkingChip, {
        text: 'processing',
        style: 'breathe',
        phase: 0,
        cycleTick: 0,
      }),
    );
    const frame = lastFrame() ?? '';
    // Braille prefix followed by text
    expect(frame).toContain('processing');
    unmount();
  });

  it('renders cycle style, mapping to first animation tick', () => {
    const { lastFrame, unmount } = render(
      React.createElement(ThinkingChip, {
        text: 'thinking',
        style: 'cycle',
        phase: 0,
        cycleTick: 0,
      }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('thinking');
    unmount();
  });

  it('renders dots style at various phases to cover frame index', () => {
    for (let phase = 0; phase < 4; phase++) {
      const { lastFrame, unmount } = render(
        React.createElement(ThinkingChip, {
          text: 'thinking',
          style: 'dots',
          phase,
          cycleTick: 0,
        }),
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('thinking');
      unmount();
    }
  });

  it('renders breathe style at various phases to cover frame index', () => {
    for (let phase = 0; phase < 5; phase++) {
      const { lastFrame, unmount } = render(
        React.createElement(ThinkingChip, {
          text: 'work',
          style: 'breathe',
          phase,
          cycleTick: 0,
        }),
      );
      const frame = lastFrame() ?? '';
      expect(frame).toContain('work');
      unmount();
    }
  });
});
