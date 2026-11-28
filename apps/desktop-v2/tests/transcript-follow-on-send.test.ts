// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EngineCommand, EngineSend } from '../src/engine-operations';
import { useFollowOnSend } from '../src/transcript-follow';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
});

/** Renders the hook and hands back every operations object it returned, render by render. */
async function mount(send: EngineSend, command: EngineCommand) {
  const resume = vi.fn();
  const seen: ReturnType<typeof useFollowOnSend>[] = [];
  function Probe({ tick }: { tick: number }) {
    seen.push(useFollowOnSend(send, command, resume));
    return createElement('span', null, tick);
  }
  root = createRoot(document.createElement('div'));
  await act(async () => root?.render(createElement(Probe, { tick: 0 })));
  return {
    resume,
    seen,
    rerender: () => act(async () => root?.render(createElement(Probe, { tick: 1 }))),
  };
}

describe('useFollowOnSend', () => {
  it('brings the reader to the end when this window sends a prompt, by send or command', async () => {
    const send = vi.fn<EngineSend>(async () => {});
    const command = vi.fn<EngineCommand>(async () => ({}));
    const { resume, seen } = await mount(send, command);
    const ops = seen.at(-1)!;

    await ops.send('user_message', { content: 'hello' });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('user_message', { content: 'hello' });

    await ops.command('user_message', { content: 'again' }, ['key.operation_result']);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(command).toHaveBeenCalledWith(
      'user_message',
      { content: 'again' },
      ['key.operation_result'],
      undefined,
    );
  });

  it('leaves the reader where they are for every other operation', async () => {
    const { resume, seen } = await mount(
      vi.fn<EngineSend>(async () => {}),
      vi.fn<EngineCommand>(async () => ({})),
    );
    const ops = seen.at(-1)!;
    await ops.send('queue.get');
    await ops.send('abort');
    await ops.command('composer.warm', {}, []);
    expect(resume).not.toHaveBeenCalled();
  });

  it('keeps the same operations across renders so composer effects do not rerun', async () => {
    const { seen, rerender } = await mount(
      vi.fn<EngineSend>(async () => {}),
      vi.fn<EngineCommand>(async () => ({})),
    );
    await rerender();
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)!.send).toBe(seen[0]!.send);
    expect(seen.at(-1)!.command).toBe(seen[0]!.command);
  });
});
