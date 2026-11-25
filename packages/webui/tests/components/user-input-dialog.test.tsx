import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const socket = vi.hoisted(() => {
  const handlers = new Map<string, Set<(message: unknown) => void>>();
  return {
    client: {
      on: vi.fn((type: string, handler: (message: unknown) => void) => {
        const set = handlers.get(type) ?? new Set();
        set.add(handler);
        handlers.set(type, set);
        return () => set.delete(handler);
      }),
      // Typed with its parameter, not `() => true`: a zero-arg mock infers a
      // `[]` call tuple, and the assertions below read `calls[0][0]`.
      send: vi.fn((_message: unknown) => true),
    },
    emit(type: string, message: unknown) {
      for (const handler of handlers.get(type) ?? []) handler(message);
    },
    reset() {
      handlers.clear();
      this.client.on.mockClear();
      this.client.send.mockClear();
    },
  };
});

vi.mock('@/lib/ws-client', () => ({ getWSClient: () => socket.client }));

import { UserInputDialog } from '../../src/components/UserInputDialog';
import { ensureSessionLane, setActiveSessionLane } from '../../src/stores/session-lanes';
import { useUserInputStore } from '../../src/stores/user-input-store';

function request(id: string, title: string) {
  return {
    type: 'user.input_requested',
    payload: {
      sessionId: id === 'r1' ? 's1' : 's2',
      request: {
        id,
        title,
        submitLabel: 'Submit answers',
        tabs: [
          {
            id: 'architecture',
            label: 'Architecture',
            questions: [
              {
                id: 'database',
                prompt: 'Database?',
                kind: 'single_select',
                required: true,
                options: [
                  { id: 'postgres', label: 'PostgreSQL', description: 'Production default' },
                  { id: 'sqlite', label: 'SQLite' },
                ],
                recommendedOptionIds: ['postgres'],
                recommendationReason: 'Handles concurrent writes.',
                allowCustomResponse: true,
              },
              {
                id: 'tenant',
                prompt: 'Tenant name?',
                kind: 'text',
                required: true,
              },
            ],
          },
          {
            id: 'delivery',
            label: 'Delivery',
            questions: [
              {
                id: 'targets',
                prompt: 'Targets?',
                kind: 'multi_select',
                required: false,
                options: [
                  { id: 'web', label: 'Web' },
                  { id: 'mobile', label: 'Mobile' },
                ],
                recommendedOptionIds: ['web'],
                allowCustomResponse: true,
              },
            ],
          },
        ],
      },
    },
  };
}

import { i18n } from '../../src/i18n';

describe('WebUI structured user input dialog', () => {
  // Pin the language before rendering: the component renders t()-derived
  // labels, and an unpinned translator can race initialization into raw keys.
  beforeEach(async () => {
    await i18n.changeLanguage('en');
  });
  beforeEach(() => {
    socket.reset();
    useUserInputStore.getState().reset();
    ensureSessionLane('s1');
    ensureSessionLane('s2');
    setActiveSessionLane('s1');
  });

  it('can explicitly decline an ACP form without answering required fields', () => {
    render(<UserInputDialog />);
    const form = request('r1', 'ACP agent “example” is asking for input');
    act(() =>
      socket.emit('user.input_requested', {
        ...form,
        payload: { ...form.payload, request: { ...form.payload.request, declineLabel: 'Decline' } },
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
    expect(socket.client.send).toHaveBeenCalledWith({
      type: 'user.input_submit',
      payload: {
        sessionId: 's1',
        response: { requestId: 'r1', status: 'declined', answers: [] },
      },
    });
  });

  it('keeps concurrent session forms queued and submits the active session atomically', async () => {
    render(<UserInputDialog />);
    act(() => {
      socket.emit('user.input_requested', request('r1', 'First session decisions'));
      socket.emit('user.input_requested', request('r2', 'Second session decisions'));
    });

    expect(screen.getByText('First session decisions')).toBeTruthy();
    expect(useUserInputStore.getState().queues.s2?.[0]?.request.id).toBe('r2');
    expect((screen.getByRole('radio', { name: /PostgreSQL/ }) as HTMLInputElement).checked).toBe(
      true,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }));
    expect(screen.getByText(/Answer required: Tenant name/)).toBeTruthy();
    const tenantInput = screen
      .getAllByRole('textbox')
      .find((element) => element.tagName.toLowerCase() === 'textarea')!;
    fireEvent.change(tenantInput, { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('tab', { name: /Delivery/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Mobile/ }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Custom answer' }), {
      target: { value: 'Desktop later' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }));

    expect(socket.client.send).toHaveBeenCalledOnce();
    expect(socket.client.send.mock.calls[0]?.[0]).toMatchObject({
      type: 'user.input_submit',
      payload: {
        sessionId: 's1',
        response: {
          requestId: 'r1',
          answers: [
            { questionId: 'database', selectedOptionIds: ['postgres'], usedRecommendation: true },
            { questionId: 'tenant', text: 'Acme', usedRecommendation: false },
            {
              questionId: 'targets',
              selectedOptionIds: ['web', 'mobile'],
              text: 'Desktop later',
              usedRecommendation: false,
            },
          ],
        },
      },
    });

    act(() =>
      socket.emit('user.input_resolved', {
        type: 'user.input_resolved',
        payload: {
          sessionId: 's1',
          requestId: 'r1',
          response: { requestId: 'r1', status: 'submitted', answers: [] },
          source: 'user',
        },
      }),
    );
    act(() => setActiveSessionLane('s2'));
    await waitFor(() => expect(screen.getByText('Second session decisions')).toBeTruthy());
  });

  it('shows progress and can restore recommendations for the active category', () => {
    render(<UserInputDialog />);
    act(() => socket.emit('user.input_requested', request('r1', 'Recommendations')));
    const postgres = screen.getByRole('radio', { name: /PostgreSQL/ }) as HTMLInputElement;
    fireEvent.click(screen.getByRole('radio', { name: /SQLite/ }));
    expect(postgres.checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Apply tab recommendations' }));
    expect(postgres.checked).toBe(true);
    expect(screen.getByRole('tab', { name: /Architecture 1\/2/ })).toBeTruthy();
  });

  it('treats manual text as a real Other radio choice', () => {
    render(<UserInputDialog />);
    act(() => socket.emit('user.input_requested', request('r1', 'Custom answer')));
    const postgres = screen.getByRole('radio', { name: /PostgreSQL/ }) as HTMLInputElement;
    const customRadio = screen.getByRole('radio', {
      name: 'Select custom answer',
    }) as HTMLInputElement;
    const customText = screen.getByRole('textbox', { name: 'Custom answer' });

    fireEvent.change(customText, { target: { value: 'CockroachDB' } });
    expect(customRadio.checked).toBe(true);
    expect(postgres.checked).toBe(false);

    fireEvent.click(postgres);
    expect(postgres.checked).toBe(true);
    expect(customRadio.checked).toBe(false);
  });

  it('delegates unanswered questions while preserving existing answers', () => {
    render(<UserInputDialog />);
    act(() => socket.emit('user.input_requested', request('r1', 'Delegated answers')));

    fireEvent.click(screen.getByRole('button', { name: 'Let model decide unanswered' }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }));

    expect(socket.client.send.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        response: {
          answers: [
            {
              questionId: 'database',
              selectedOptionIds: ['postgres'],
              delegated: false,
              usedRecommendation: true,
            },
            {
              questionId: 'tenant',
              selectedOptionIds: [],
              delegated: true,
              usedRecommendation: false,
            },
            {
              questionId: 'targets',
              selectedOptionIds: ['web'],
              delegated: false,
              usedRecommendation: true,
            },
          ],
        },
      },
    });
  });

  it('re-enables the form when the server never confirms the submit', () => {
    render(<UserInputDialog />);
    act(() => socket.emit('user.input_requested', request('r1', 'Timeout')));
    const tenant = screen
      .getAllByRole('textbox')
      .find((element) => element.tagName.toLowerCase() === 'textarea')!;
    fireEvent.change(tenant, { target: { value: 'Acme' } });

    // Arm BEFORE the submit so the timeout lands on the fake clock; real
    // timers stay in charge of the radix dialog mount above.
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }));
      expect(
        (screen.getByRole('button', { name: 'Submitting…' }) as HTMLButtonElement).disabled,
      ).toBe(true);

      // The send "succeeded" (queued), so only the client-side submit
      // timeout can unlock the form when the frame is later dropped.
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      expect(screen.getByRole('button', { name: 'Submit answers' })).toBeTruthy();
      expect(screen.getByText(/No confirmation received/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancel answers the server with status cancelled and unlocks the form', () => {
    render(<UserInputDialog />);
    act(() => socket.emit('user.input_requested', request('r1', 'Cancel')));
    const tenant = screen
      .getAllByRole('textbox')
      .find((element) => element.tagName.toLowerCase() === 'textarea')!;
    fireEvent.change(tenant, { target: { value: 'Acme' } });

    fireEvent.click(screen.getByRole('button', { name: 'Submit answers' }));
    expect(
      (screen.getByRole('button', { name: 'Submitting…' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(socket.client.send).toHaveBeenCalledTimes(2);
    expect(socket.client.send.mock.calls[1]?.[0]).toMatchObject({
      type: 'user.input_submit',
      payload: {
        sessionId: 's1',
        response: { requestId: 'r1', status: 'cancelled', answers: [] },
      },
    });
    expect(screen.getByRole('button', { name: 'Submit answers' })).toBeTruthy();
    expect(screen.getByText(/Cancel requested/)).toBeTruthy();
  });
});
