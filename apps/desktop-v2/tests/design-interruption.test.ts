import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { EngineEvent } from '../src/engine-state';
import { emptyEngineState, reduceEngine } from '../src/engine-state';
import { SessionActivity } from '../src/SessionActivity';
import { activityRows } from '../src/session-activity-model';

const start = (eventEpoch: string, reset = false): EngineEvent => ({
  type: 'session.start',
  payload: { sessionId: 'design-owner', provider: 'local', model: 'fixture', eventEpoch, reset },
});
const tool = (id = 'extract'): EngineEvent => ({
  type: 'tool.started',
  payload: {
    sessionId: 'design-owner',
    id,
    name: 'design_reference',
    input: { action: 'extract' },
  },
});
const progress: EngineEvent = {
  type: 'tool.progress',
  payload: {
    sessionId: 'design-owner',
    id: 'extract',
    name: 'design_reference',
    event: {
      text: '[3/4] Synthesizing',
      path: '.design/references/partial/DESIGN.md',
      operation: 'write',
    },
  },
};
const stateOf = (events: EngineEvent[]) => events.reduce(reduceEngine, emptyEngineState);
const toolsOf = (events: EngineEvent[]) =>
  activityRows(stateOf(events).activity).filter((row) => row.kind === 'tool');

describe('design extraction process boundaries', () => {
  it('keeps a live extraction during same-engine metadata updates', () => {
    expect(toolsOf([start('engine-a'), tool(), progress, start('engine-a')])[0]?.status).toBe(
      'running',
    );
  });

  it.each([start('engine-b'), start('engine-a', true)])(
    'retires unfinished extraction at %j',
    (boundary) => {
      const state = stateOf([start('engine-a'), tool(), progress, boundary]);
      expect(activityRows(state.activity).find((row) => row.kind === 'tool')?.status).toBe(
        'aborted',
      );
      const html = renderToStaticMarkup(
        createElement(SessionActivity, {
          events: state.activity,
          onOpenFile: vi.fn(),
        }),
      );
      expect(html).not.toContain('aria-current="step"');
      expect(html).not.toContain('Open DESIGN.md');
      expect(html).toContain('data-state="failed"');
    },
  );

  it('does not revive the interrupted row or its partial artifact when a later tool reuses its id', () => {
    const rows = toolsOf([start('engine-a'), tool(), progress, start('engine-b'), tool()]);
    expect(rows.map((row) => row.status)).toEqual(['aborted', 'running']);
    expect(rows[0]?.id).not.toBe(rows[1]?.id);
    expect(rows[1]?.files).toEqual([]);
  });

  it('preserves a completed artifact and an explicitly aborted run', () => {
    const rows = toolsOf([
      start('engine-a'),
      tool('complete'),
      {
        type: 'tool.executed',
        payload: {
          id: 'complete',
          name: 'design_reference',
          ok: true,
          output: 'Full 10-section DESIGN.md specification: .design/references/complete/DESIGN.md.',
        },
      },
      tool(),
      progress,
      { type: 'run.result', payload: { status: 'aborted' } },
      start('engine-b'),
    ]);
    expect(rows.map((row) => row.status)).toEqual(['done', 'aborted']);
  });

  it('settles progress after the original tool and process start have left the bounded activity history', () => {
    const churn: EngineEvent[] = Array.from({ length: 450 }, (_, index) => ({
      type: 'provider.retry',
      payload: { providerId: 'local', attempt: index + 1 },
    }));
    const rows = toolsOf([start('engine-a'), tool(), ...churn, progress, start('engine-b')]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('aborted');
  });
});
