// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { useConversationShortcuts } from '../src/ConversationShortcuts';
import { useTranscriptFind } from '../src/TranscriptFind';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it('disables navigation/help/focus shortcuts while leaving conversation Find available', async () => {
  const navigate = vi.fn(),
    focus = vi.fn();
  function Harness({ enabled }: { enabled: boolean }) {
    const overlay = useConversationShortcuts(navigate, enabled, focus);
    const find = useTranscriptFind({ messages: [], enabled: true, reveal: () => {} });
    return createElement('div', null, overlay, find.bar);
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const press = (key: string, ctrlKey = false) =>
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey, bubbles: true }));
    });
  try {
    await act(async () => root.render(createElement(Harness, { enabled: true })));
    press('F5');
    expect(navigate).toHaveBeenCalledOnce();
    press('/', true);
    expect(focus).toHaveBeenCalledOnce();
    await act(async () => root.render(createElement(Harness, { enabled: false })));
    press('F5');
    press('/', true);
    press('F1');
    expect(navigate).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledOnce();
    expect(host.querySelector('dialog')).toBeNull();
    press('f', true);
    expect(host.querySelector('input[data-find-input="conversation"]')).not.toBeNull();
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
