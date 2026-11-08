import { HOST_CAPABILITY_ETERNAL_AUTONOMY } from '@wrongstack/webui-protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { agentModes } from '../src/AgentModeControl';
import { AutoContinue } from '../src/AutoContinue';
import { AutonomyControl, autonomyControlInputs } from '../src/AutonomyControl';
import {
  autoContinueStep,
  autonomyModeAvailable,
  DEFAULT_AUTO_CONTINUE_LIMIT,
  sessionAutonomy,
  unavailableAutonomyModes,
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
      createElement(AutonomyControl, { prefs: {}, command, disabled: false }),
    );
    expect(html).toContain('>Continuation</option>');
    for (const label of ['Manual', 'Suggest next steps', 'Continue automatically', 'Eternal'])
      expect(html).toContain(label);
    // The YOLO level beside it, as the WebUI's session panel offers it.
    expect(html).toContain('class="composer-chip effort-control yolo-off"');
    for (const label of ['Approvals on', '>YOLO<', 'YOLO+']) expect(html).toContain(label);
    const plus = renderToStaticMarkup(
      createElement(AutonomyControl, {
        prefs: { autonomy: 'auto', yolo: true, yoloPlus: true },
        command,
        disabled: false,
      }),
    );
    expect(plus).toContain('yolo-plus');
    expect(plus).toContain('title="Every call runs and nothing asks; deny rules still refuse."');
  });
});

describe('eternal modes need an engine that drives them', () => {
  const driving = { protocolCapabilities: [HOST_CAPABILITY_ETERNAL_AUTONOMY] };
  const disabledOptions = (html: string) =>
    [...html.matchAll(/<option value="([^"]*)" disabled=""[^>]*>/g)].map((match) => match[1]);

  it('is available only when session.start announces the eternal driver', () => {
    for (const mode of ['off', 'suggest', 'auto'])
      expect(autonomyModeAvailable(mode, undefined)).toBe(true);
    for (const mode of ['eternal', 'eternal-parallel']) {
      expect(autonomyModeAvailable(mode, undefined)).toBe(false);
      expect(autonomyModeAvailable(mode, { protocolCapabilities: ['session.user-ack'] })).toBe(
        false,
      );
      expect(autonomyModeAvailable(mode, driving)).toBe(true);
    }
    expect([...unavailableAutonomyModes(undefined, 'why').entries()]).toEqual([
      ['eternal', 'why'],
      ['eternal-parallel', 'why'],
    ]);
    expect(unavailableAutonomyModes(driving, 'why').size).toBe(0);
  });

  it('lists eternal modes but does not let them be chosen, saying why', () => {
    const command = async () => ({});
    const html = renderToStaticMarkup(
      createElement(AutonomyControl, { prefs: { autonomy: 'auto' }, command, disabled: false }),
    );
    expect(disabledOptions(html)).toEqual(['eternal', 'eternal-parallel']);
    expect(html).toContain('title="Not available here: this engine does not run the eternal loop');
    const offered = renderToStaticMarkup(
      createElement(AutonomyControl, {
        prefs: { autonomy: 'auto' },
        sessionStart: driving,
        command,
        disabled: false,
      }),
    );
    expect(disabledOptions(offered)).toEqual([]);
    // The composer hands the control both engine reports it reads.
    expect(
      autonomyControlInputs({ 'prefs.updated': { autonomy: 'auto' }, 'session.start': driving }),
    ).toEqual({ prefs: { autonomy: 'auto' }, sessionStart: driving });
  });

  it('explains a conversation already left on an eternal mode', () => {
    const html = renderToStaticMarkup(
      createElement(AutonomyControl, {
        prefs: { autonomy: 'eternal' },
        command: async () => ({}),
        disabled: false,
      }),
    );
    expect(html).toMatch(/<label class="composer-chip effort-control" title="Not available here/);
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
