// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { useComposerCollapse } from '../src/useComposerCollapse';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;
afterEach(() => {
  if (root) act(() => root.unmount());
  host?.remove();
});
const initial = {
  sessionId: 'one',
  hasMessages: true,
  enabled: false,
  running: false,
  blocked: false,
};
function Harness(props: typeof initial) {
  const fold = useComposerCollapse(props);
  return createElement(
    'button',
    {
      type: 'button',
      'data-collapsed': String(fold.collapsed),
      onClick: fold.collapsed ? fold.expand : fold.collapse,
    },
    'Toggle',
  );
}
async function mount(props = initial) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await update(props);
}
const update = async (props: typeof initial) => {
  await act(async () => root.render(createElement(Harness, props)));
};
const collapsed = () => host.querySelector('button')?.getAttribute('data-collapsed') === 'true';

describe('composer folding without losing active work', () => {
  it('is opt-in, responds to enabling, and keeps a manual expansion through later message growth', async () => {
    await mount();
    expect(collapsed()).toBe(false);
    await update({ ...initial, enabled: true });
    expect(collapsed()).toBe(true);
    act(() => host.querySelector('button')?.click());
    expect(collapsed()).toBe(false);
    await update({ ...initial, enabled: true, running: true });
    await update({ ...initial, enabled: true });
    expect(collapsed()).toBe(false);
    await update({ ...initial, enabled: true, sessionId: 'two' });
    expect(collapsed()).toBe(true);
    await update({ ...initial, enabled: false, sessionId: 'two' });
    expect(collapsed()).toBe(false);
  });
  it('keeps drafts, attachments and other active-work blockers open, and never collapses a running turn', async () => {
    await mount({ ...initial, enabled: true, blocked: true });
    expect(collapsed()).toBe(false);
    await update({ ...initial, enabled: true, sessionId: 'two', running: true });
    expect(collapsed()).toBe(false);
    await update({ ...initial, enabled: true, sessionId: 'two' });
    expect(collapsed()).toBe(false);
    await update({ ...initial, enabled: true, sessionId: 'three' });
    expect(collapsed()).toBe(true);
    await update({ ...initial, enabled: true, sessionId: 'three', blocked: true });
    expect(collapsed()).toBe(false);
  });
});
