// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Composer } from '../src/components/composer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Frame = { type: string; payload?: Record<string, unknown> };
let listeners: Set<(frame: Frame) => void>;
let sent: Array<{ type: string; payload: Record<string, unknown> }>;
let host: HTMLDivElement;
let root: Root;

const controller = {
  state: { id: 's1', model: 'm', running: false, prefs: {} },
  connection: 'open',
  ready: true,
  modelPending: false,
  compactPending: false,
  queue: [],
  queuePaused: false,
  draftRequest: null,
  hasActiveWork: false,
  send: (type: string, payload: Record<string, unknown> = {}) => {
    sent.push({ type, payload });
    return true;
  },
  subscribe: (listener: (frame: Frame) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  submit: () => true,
  removeQueued: () => {},
  moveQueued: () => {},
  toggleQueue: () => {},
  consumeDraft: () => {},
  notice: () => {},
  stopAll: () => true,
  recordBtw: () => {},
} as never;

beforeEach(() => {
  listeners = new Set();
  sent = [];
  localStorage.clear();
  Element.prototype.scrollIntoView ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    disconnect() {}
  } as never;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

async function openSkillPicker() {
  await act(async () => {
    root.render(createElement(Composer, { controller }));
  });
  const textarea = host.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]');
  expect(textarea, 'composer textarea renders').not.toBeNull();

  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  await act(async () => {
    setter.call(textarea!, '$');
    textarea!.setSelectionRange(1, 1);
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const request = sent.find((item) => item.type === 'skills.list');
  expect(request, 'opener requests skills').toBeTruthy();
  await act(async () => {
    for (const listener of listeners)
      listener({
        type: 'skills.list',
        payload: {
          requestId: request!.payload.requestId,
          enabled: true,
          skills: [{ name: 'review', description: 'Review the change' }],
        },
      });
  });
  const option = host.querySelector<HTMLElement>('[aria-label="Matching skills"] [role="option"]');
  expect(option, 'skill option renders').not.toBeNull();
  expect(textarea!.getAttribute('aria-activedescendant')).toBe(option!.id);
  return textarea!;
}

describe('composer skill-picker keyboard navigation (WCAG 2.1.1)', () => {
  it('leaves Shift+Tab to browser focus navigation without picking a mention', async () => {
    const textarea = await openSkillPicker();
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      textarea.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(textarea.value).toBe('$');
  });

  it('keeps plain Tab as a mention insertion', async () => {
    const textarea = await openSkillPicker();
    const event = new KeyboardEvent('keydown', {
      key: 'Tab',
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      textarea.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(textarea.value).toBe('$review ');
  });
});
