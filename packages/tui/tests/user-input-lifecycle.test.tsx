import { EventBus } from '@wrongstack/contracts/kernel';
import type { UserInputRequest } from '@wrongstack/contracts/types';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { UserInputPrompt, usePendingUserInput } from '../src/components/user-input-prompt.js';
import { Text } from '../src/ink.js';
import { renderRealTty, settle } from './helpers/real-tty.js';

const request = (id: string, recommendedText?: string): UserInputRequest => ({
  id,
  title: `Form ${id}`,
  tabs: [
    {
      id: 'tab',
      label: 'Answers',
      questions: [
        {
          id: 'answer',
          prompt: 'Your answer?',
          kind: 'text',
          required: true,
          ...(recommendedText ? { recommendedText } : {}),
        },
      ],
    },
  ],
});

describe('question lifecycle and input', () => {
  it('does not carry an answer into a new request with the same question id', async () => {
    const resolve = vi.fn();
    const view = render(
      <UserInputPrompt pending={{ request: request('first', 'secret first answer'), resolve }} />,
    );
    try {
      await settle();
      view.rerender(<UserInputPrompt pending={{ request: request('second'), resolve }} />);
      await settle();
      view.stdin.write('s');
      await settle();
      expect(resolve).not.toHaveBeenCalled();
      expect(view.lastFrame()).toContain('SUBMIT LOCKED');
      expect(view.lastFrame()).not.toContain('secret first answer');
    } finally {
      view.unmount();
    }
  });

  it('submits only once while waiting for the resolved event', async () => {
    const resolve = vi.fn();
    const view = render(
      <UserInputPrompt pending={{ request: request('once', 'answer'), resolve }} />,
    );
    try {
      await settle();
      view.stdin.write('s');
      view.stdin.write('s');
      await settle();
      expect(resolve).toHaveBeenCalledOnce();
    } finally {
      view.unmount();
    }
  });

  it('does not interpret Ctrl+D as delegating the answer', async () => {
    const resolve = vi.fn();
    const view = render(<UserInputPrompt pending={{ request: request('modifiers'), resolve }} />);
    try {
      await settle();
      view.stdin.write('\x04');
      await settle();
      view.stdin.write('s');
      await settle();
      expect(resolve).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  });

  it('keeps pending questions in request order', async () => {
    const events = new EventBus();
    function Harness() {
      const pending = usePendingUserInput(events);
      return <Text>{pending?.request.id ?? 'none'}</Text>;
    }
    const view = render(<Harness />);
    try {
      await settle();
      events.emit('user.input_requested', { request: request('first'), resolve: vi.fn() });
      events.emit('user.input_requested', { request: request('second'), resolve: vi.fn() });
      await settle();
      expect(view.lastFrame()).toBe('first');
      events.emit('user.input_resolved', {
        requestId: 'first',
        response: { requestId: 'first', status: 'submitted', answers: [] },
        source: 'user',
      });
      await settle();
      expect(view.lastFrame()).toBe('second');
    } finally {
      view.unmount();
    }
  });

  it('responds to terminal resizing without needing another keypress', async () => {
    const view = renderRealTty(
      <UserInputPrompt pending={{ request: request('resize'), resolve: vi.fn() }} />,
      { columns: 110, rows: 40 },
    );
    try {
      await settle();
      view.resize(52, 16);
      await settle();
      expect(view.lines().length).toBeLessThanOrEqual(16);
      expect(view.lastFrame()).toContain('SUBMIT LOCKED');
    } finally {
      view.unmount();
    }
  });
});

describe('question escape hatch and Unicode editing', () => {
  it('cancels the request and forwards Ctrl+C to the app interrupt ladder', async () => {
    const resolve = vi.fn();
    const onInterrupt = vi.fn();
    const view = render(
      <UserInputPrompt
        pending={{ request: request('interrupt'), resolve }}
        onInterrupt={onInterrupt}
      />,
    );
    try {
      await settle();
      view.stdin.write('\x03');
      await settle();
      expect(resolve).toHaveBeenCalledWith({
        requestId: 'interrupt',
        status: 'cancelled',
        answers: [],
      });
      expect(onInterrupt).toHaveBeenCalledOnce();
      view.stdin.write('\x03');
      await settle();
      expect(resolve).toHaveBeenCalledOnce();
      expect(onInterrupt).toHaveBeenCalledTimes(2);
    } finally {
      view.unmount();
    }
  });
  it('backspace removes a complete composed emoji in a manual answer', async () => {
    const resolve = vi.fn();
    const view = render(<UserInputPrompt pending={{ request: request('unicode'), resolve }} />);
    try {
      await settle();
      view.stdin.write('\r');
      await settle();
      view.stdin.write('👩‍💻');
      await settle();
      view.stdin.write('\x7f');
      await settle();
      view.stdin.write('\r');
      await settle();
      view.stdin.write('s');
      await settle();
      expect(resolve).not.toHaveBeenCalled();
      expect(view.lastFrame()).toContain('SUBMIT LOCKED');
    } finally {
      view.unmount();
    }
  });
});
