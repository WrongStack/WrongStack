// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PREFERENCE_ECHO_TIMEOUT_MS, usePendingPreference } from '../src/usePendingPreference';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
let api: ReturnType<typeof usePendingPreference>;
afterEach(() => {
  if (root) act(() => root.unmount());
  host?.remove();
  vi.useRealTimers();
});
function Harness({ streamed, saving }: { streamed: boolean; saving: boolean }) {
  api = usePendingPreference(streamed, saving);
  return null;
}
async function mount(streamed: boolean, saving = false) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await render(streamed, saving);
}
const render = (streamed: boolean, saving: boolean) =>
  act(async () => root.render(createElement(Harness, { streamed, saving })));

describe('a toggle backed by an engine preference', () => {
  it('keeps a confirmed choice while older stream frames still report the previous value', async () => {
    // The profile streams refinement on; the user switches it off and the save is confirmed.
    await mount(true);
    await act(async () => api.setPending(false));
    await render(true, true);
    await render(true, false);
    // The engine reply arrived before the journal: the toggle must not flip back to on.
    expect(api.value).toBe(false);
    // A late frame of the profile's original value is still not the user's choice.
    await render(true, false);
    expect(api.value).toBe(false);
    // Once the stream reports the saved value, the stream is the source again.
    await render(false, false);
    expect(api.pending).toBeNull();
    expect(api.value).toBe(false);
  });

  it('shows the streamed value again when a save is refused', async () => {
    await mount(true);
    await act(async () => api.setPending(false));
    await act(async () => api.setPending(null));
    expect(api.value).toBe(true);
  });

  it('lets the stream win when it never echoes the choice', async () => {
    vi.useFakeTimers();
    await mount(true);
    await act(async () => api.setPending(false));
    expect(api.value).toBe(false);
    await act(async () => vi.advanceTimersByTime(PREFERENCE_ECHO_TIMEOUT_MS));
    expect(api.pending).toBeNull();
    expect(api.value).toBe(true);
  });

  it('follows the stream when nothing is pending', async () => {
    await mount(false);
    expect(api.value).toBe(false);
    await render(true, false);
    expect(api.value).toBe(true);
  });
});
