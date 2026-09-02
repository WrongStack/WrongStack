import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RunControlBar, RunTaskControls } from '../../src/components/KanbanRunControls.js';

/**
 * The bug these pin: the server falls back to its `latest` run when a
 * control message carries no runId, so with two mirror boards open, Stop
 * on board A killed board B's run. The client message union declared the
 * runId field all along — no send site was populating it.
 */
describe('KanbanRunControls runId threading', () => {
  it('RunControlBar sends runId on every run-control message', () => {
    const sendRaw = vi.fn();
    const { container } = render(
      <RunControlBar runLink={{ engine: 'sdd', runId: 'run-A' }} sendRaw={sendRaw} />,
    );
    for (const button of Array.from(container.querySelectorAll('button'))) {
      fireEvent.click(button);
    }
    expect(sendRaw.mock.calls.length).toBeGreaterThanOrEqual(4);
    for (const [type, payload] of sendRaw.mock.calls) {
      expect(payload, `${String(type)} was sent without the mirrored run's id`).toEqual(
        expect.objectContaining({ runId: 'run-A' }),
      );
    }
    expect(sendRaw.mock.calls.map(([type]) => type)).toEqual(
      expect.arrayContaining(['sdd.board.pause', 'sdd.board.resume', 'sdd.board.stop']),
    );
  });

  it('RunControlBar omits runId when the board tag carries none', () => {
    const sendRaw = vi.fn();
    const { container } = render(<RunControlBar runLink={{ engine: 'goal' }} sendRaw={sendRaw} />);
    for (const button of Array.from(container.querySelectorAll('button'))) {
      fireEvent.click(button);
    }
    for (const [, payload] of sendRaw.mock.calls) {
      expect(payload).not.toHaveProperty('runId');
    }
  });

  it('RunTaskControls threads runId alongside the taskId', () => {
    const sendRaw = vi.fn();
    const element = (
      <RunTaskControls
        runLink={{ engine: 'sdd', runId: 'run-A' }}
        runTaskId="task-7"
        modelCandidates={[]}
        sendRaw={sendRaw}
      />
    );
    // Click each button in a fresh render: the Reassign toggle swaps the
    // action row for an input, unmounting its siblings mid-iteration.
    const probe = render(element);
    const buttonCount = probe.container.querySelectorAll('button').length;
    probe.unmount();
    for (let index = 0; index < buttonCount; index++) {
      const view = render(element);
      const button = view.container.querySelectorAll('button')[index];
      if (button) fireEvent.click(button);
      view.unmount();
    }
    const sent = sendRaw.mock.calls.filter(([type]) => typeof type === 'string');
    expect(sent.map(([type]) => type)).toEqual(
      expect.arrayContaining(['sdd.board.retry', 'sdd.board.cancel_task']),
    );
    for (const [type, payload] of sent) {
      expect(payload, `${String(type)} missing runId`).toEqual(
        expect.objectContaining({ runId: 'run-A', taskId: 'task-7' }),
      );
    }
  });
});
