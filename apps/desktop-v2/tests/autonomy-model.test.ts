import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { agentModes } from '../src/AgentModeControl';
import { AutoContinue } from '../src/AutoContinue';
import { AutonomyControl } from '../src/AutonomyControl';
import {
  autoContinueStep,
  DEFAULT_AUTO_CONTINUE_LIMIT,
  sessionAutonomy,
} from '../src/autonomy-model';

const steps = [
  { index: 1, text: 'Review the diff' },
  { index: 2, text: 'Run the tests', auto: true },
];

describe('conversation continuation', () => {
  it('reads the mode, YOLO and limit from the session preferences', () => {
    expect(
      sessionAutonomy({ autonomy: 'auto', yoloPlus: true, autoProceedMaxIterations: 0 }),
    ).toEqual({ mode: 'auto', yolo: true, limit: 0 });
    expect(sessionAutonomy({ autonomy: 'nonsense', yolo: false })).toEqual({
      mode: '',
      yolo: false,
      limit: DEFAULT_AUTO_CONTINUE_LIMIT,
    });
    expect(sessionAutonomy(undefined).mode).toBe('');
  });

  it('continues only in auto mode with YOLO, below the limit, preferring the auto-marked step', () => {
    const base = { mode: 'auto' as const, yolo: true, limit: 3, count: 0, steps };
    expect(autoContinueStep(base)?.text).toBe('Run the tests');
    expect(autoContinueStep({ ...base, steps: [steps[0]!] })?.text).toBe('Review the diff');
    expect(autoContinueStep({ ...base, yolo: false })).toBeNull();
    expect(autoContinueStep({ ...base, mode: 'suggest' })).toBeNull();
    expect(autoContinueStep({ ...base, count: 3 })).toBeNull();
    expect(autoContinueStep({ ...base, limit: 0, count: 500 })?.text).toBe('Run the tests');
    expect(autoContinueStep({ ...base, steps: [] })).toBeNull();
  });

  it('shows the countdown with the chosen step and a cancel button', () => {
    const html = renderToStaticMarkup(
      createElement(AutoContinue, { stepKey: '2:Run', text: 'Run the tests', onSubmit: () => {} }),
    );
    expect(html).toContain('Continuing in 5 s with: <strong>Run the tests</strong>');
    expect(html).toContain('Cancel');
  });

  it('offers every mode and marks an unreported one', () => {
    const command = async () => ({});
    const html = renderToStaticMarkup(
      createElement(AutonomyControl, { mode: '', command, disabled: false }),
    );
    expect(html).toContain('Continuation: not reported');
    for (const label of ['Manual', 'Suggest next steps', 'Continue automatically', 'Eternal'])
      expect(html).toContain(label);
  });
});

describe('agent modes', () => {
  it('lists installed modes without the built-in default and reads the active one', () => {
    expect(
      agentModes({
        modes: [
          { id: 'default', name: 'Default' },
          { id: 'review', name: 'Reviewer', description: 'Read-only review' },
          { id: 'plain' },
          { name: 'no id' },
        ],
        activeId: 'review',
      }),
    ).toEqual({
      modes: [
        { id: 'review', name: 'Reviewer', description: 'Read-only review' },
        { id: 'plain', name: 'plain', description: '' },
      ],
      activeId: 'review',
    });
    expect(agentModes({ modes: [], error: 'Mode store not available' })).toEqual({
      modes: [],
      activeId: 'default',
    });
  });
});
