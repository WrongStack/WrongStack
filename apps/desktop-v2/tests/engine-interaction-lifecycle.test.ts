import { describe, expect, it } from 'vitest';
import { emptyEngineState, reduceEngine } from '../src/engine-state';
import { savedInputText } from '../src/input-form-model';

const request = {
  id: 'question-a',
  title: 'Decisions',
  tabs: [
    {
      id: 'review',
      label: 'Review',
      questions: [{ id: 'answer', prompt: 'Your decision', kind: 'text' as const, required: true }],
    },
  ],
};
function waiting() {
  const state = reduceEngine(emptyEngineState, {
    type: 'session.start',
    payload: { sessionId: 'core-a', eventEpoch: 'engine-a', provider: 'local', model: 'fixture' },
  });
  const input = reduceEngine(state, {
    type: 'user.input_requested',
    payload: { sessionId: 'core-a', request },
  });
  return reduceEngine(
    { ...input, running: true },
    {
      type: 'tool.confirm_needed',
      payload: { sessionId: 'core-a', id: 'approval-a', tool: 'exec' },
    },
  );
}
describe('engine interaction lifecycle', () => {
  it('copies human question and option labels rather than runtime request ids', () => {
    const form = {
      ...request,
      tabs: [
        {
          id: 'choices',
          label: 'Choices',
          questions: [
            { id: 'text', prompt: 'Notes', kind: 'text' as const, required: true },
            {
              id: 'choice',
              prompt: 'Stack',
              kind: 'single_select' as const,
              options: [{ id: 'internal-a', label: 'React' }],
            },
            { id: 'delegate', prompt: 'Let it choose', kind: 'text' as const },
          ],
        },
      ],
    };
    expect(
      savedInputText(
        form,
        {
          text: { text: 'Keep my draft', selectedOptionIds: [], delegated: false },
          choice: { text: '', selectedOptionIds: ['internal-a'], delegated: false },
          delegate: { text: '', selectedOptionIds: [], delegated: true },
        },
        'Let the model decide',
      ),
    ).toBe(
      'Decisions\n\nNotes\nKeep my draft\n\nStack\nReact\n\nLet it choose\nLet the model decide',
    );
    expect(savedInputText(request, {}, 'Delegate')).toBe('');
  });
  it('keeps live questions and approvals during an ordinary session update', () => {
    const before = waiting();
    const updated = reduceEngine(before, {
      type: 'session.start',
      payload: { sessionId: 'core-a', provider: 'local', model: 'fixture' },
    });
    expect(updated.inputs).toEqual([request]);
    expect(updated.approvals).toHaveLength(1);
    expect(updated.running).toBe(true);
  });
  it('retires old runtime interactions on reconnect without losing question metadata', () => {
    const reset = reduceEngine(waiting(), {
      type: 'session.start',
      payload: { sessionId: 'core-a', reset: true, replayMessages: [] },
    });
    expect(reset.inputs).toEqual([]);
    expect(reset.approvals).toEqual([]);
    expect(reset.running).toBe(false);
    expect(reset.archivedInputs).toEqual([request]);
  });
  it('retires interactions when the recorded session resumes in a new engine epoch without reset', () => {
    let before = waiting();
    for (const eventEpoch of ['engine-a', undefined]) {
      before = reduceEngine(before, {
        type: 'session.start',
        payload: { sessionId: 'core-a', eventEpoch, provider: 'local', model: 'fixture' },
      });
      expect(before.inputs).toEqual([request]);
      expect(before.approvals).toHaveLength(1);
    }
    const resumed = reduceEngine(before, {
      type: 'session.start',
      payload: { sessionId: 'core-a', eventEpoch: 'engine-b', replayMessages: [] },
    });
    expect(resumed.inputs).toEqual([]);
    expect(resumed.approvals).toEqual([]);
    expect(resumed.running).toBe(false);
    expect(resumed.archivedInputs).toEqual([request]);
  });
  it('archives an aborted question and promotes a genuinely reissued request back to live', () => {
    const aborted = reduceEngine(waiting(), {
      type: 'user.input_resolved',
      payload: { sessionId: 'core-a', requestId: request.id, source: 'abort' },
    });
    expect(aborted.inputs).toEqual([]);
    expect(aborted.archivedInputs).toEqual([request]);
    const live = reduceEngine(aborted, {
      type: 'user.input_requested',
      payload: { sessionId: 'core-a', request },
    });
    expect(live.inputs).toEqual([request]);
    expect(live.archivedInputs).toEqual([]);
  });
});
