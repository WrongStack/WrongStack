import type { SetStateAction } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  closeStaleToolCalls,
  handleToolExecuted,
  handleToolStarted,
} from '../src/lib/message-handler-tool-events.js';
import type { ServerMessage, ToolCallInfo } from '../src/types.js';

function toolState(initial: ToolCallInfo[] = []) {
  let current = initial;
  const setToolCalls = vi.fn((update: SetStateAction<ToolCallInfo[]>) => {
    current =
      typeof update === 'function'
        ? (update as (prev: ToolCallInfo[]) => ToolCallInfo[])(current)
        : update;
  });
  return { setToolCalls, read: () => current };
}

function startedFrame(id: string, name: string): ServerMessage {
  return {
    type: 'tool.started',
    payload: { id, name, input: { path: 'a.ts' } },
  } as ServerMessage;
}

function executedFrame(id: string, name: string, ok = true): ServerMessage {
  return {
    type: 'tool.executed',
    payload: { id, name, ok, output: 'result text' },
  } as ServerMessage;
}

describe('handleToolExecuted', () => {
  it('updates the matching running entry in place', () => {
    const { setToolCalls, read } = toolState();
    handleToolStarted(startedFrame('t-1', 'read'), new Map(), vi.fn(), vi.fn(), setToolCalls);
    handleToolExecuted(executedFrame('t-1', 'read'), new Map(), vi.fn(), vi.fn(), setToolCalls);

    expect(read()).toHaveLength(1);
    expect(read()[0]).toMatchObject({
      id: 't-1',
      name: 'read',
      status: 'done',
      output: 'result text',
    });
  });

  it('appends a terminal entry when executed arrives without a started frame', () => {
    const { setToolCalls, read } = toolState();
    // Connect gap / resumed mid-run: the started frame never arrived, but
    // the executed result must not be silently dropped.
    handleToolExecuted(
      executedFrame('t-orphan', 'grep'),
      new Map(),
      vi.fn(),
      vi.fn(),
      setToolCalls,
    );

    expect(read()).toHaveLength(1);
    expect(read()[0]).toMatchObject({
      id: 't-orphan',
      name: 'grep',
      status: 'done',
      output: 'result text',
    });
  });

  it('appends an error entry for a failed orphan execution', () => {
    const { setToolCalls, read } = toolState();
    handleToolExecuted(
      executedFrame('t-bad', 'bash', false),
      new Map(),
      vi.fn(),
      vi.fn(),
      setToolCalls,
    );

    expect(read()[0]).toMatchObject({ id: 't-bad', status: 'error' });
  });

  it('does not duplicate an already-closed tool call', () => {
    const { setToolCalls, read } = toolState([
      { id: 't-1', name: 'read', input: {}, status: 'done', output: 'earlier' },
    ]);
    handleToolExecuted(executedFrame('t-1', 'read'), new Map(), vi.fn(), vi.fn(), setToolCalls);

    expect(read()).toHaveLength(1);
    expect(read()[0]).toMatchObject({ status: 'done', output: 'earlier' });
  });
});

describe('closeStaleToolCalls', () => {
  it('closes running entries and leaves terminal ones alone', () => {
    const { setToolCalls, read } = toolState([
      { id: 't-run', name: 'read', input: {}, status: 'running' },
      { id: 't-done', name: 'grep', input: {}, status: 'done' },
    ]);
    closeStaleToolCalls(setToolCalls);

    expect(read()).toMatchObject([
      { id: 't-run', status: 'error' },
      { id: 't-done', status: 'done' },
    ]);
  });

  it('is a no-op when nothing is running', () => {
    const { setToolCalls, read } = toolState([
      { id: 't-done', name: 'grep', input: {}, status: 'done' },
    ]);
    closeStaleToolCalls(setToolCalls);
    expect(read()).toHaveLength(1);
    expect(read()[0]).toMatchObject({ status: 'done' });
  });
});
