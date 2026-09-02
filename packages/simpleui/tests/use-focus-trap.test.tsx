// @vitest-environment jsdom

import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useFocusTrap } from '../src/hooks/use-focus-trap.js';

const roots: Root[] = [];

beforeEach(() => {
  document.body.replaceChildren();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
});

function Probe(props: { active: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  useFocusTrap(ref, props.active);
  return (
    <div>
      <button type="button" id="outside-first">
        Outside first
      </button>
      <div id="trap-dialog" role="dialog" aria-modal="true" tabIndex={-1} ref={ref}>
        <button type="button" id="inside-first">
          Inside first
        </button>
        <input id="inside-input" aria-label="Sample input" />
        <button type="button" id="inside-last">
          Inside last
        </button>
      </div>
      <button type="button" id="outside-last">
        Outside last
      </button>
    </div>
  );
}

function keydown(target: HTMLElement, key: string, shiftKey = false): void {
  act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
    );
  });
}

function renderProbe(active: boolean): void {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(<Probe active={active} />));
}

describe('useFocusTrap', () => {
  it('wraps Tab forward from the last focusable back to the first', () => {
    renderProbe(true);
    const last = document.getElementById('inside-last');
    if (!last) throw new Error('last button missing');
    last.focus();
    keydown(last, 'Tab');
    expect(document.activeElement?.id).toBe('inside-first');
  });

  it('wraps Shift+Tab from the first focusable back to the last', () => {
    renderProbe(true);
    const first = document.getElementById('inside-first');
    if (!first) throw new Error('first button missing');
    first.focus();
    keydown(first, 'Tab', true);
    expect(document.activeElement?.id).toBe('inside-last');
  });

  it('pulls focus back inside when Tab starts outside the dialog', () => {
    renderProbe(true);
    const outside = document.getElementById('outside-first');
    if (!outside) throw new Error('outside button missing');
    outside.focus();
    keydown(outside, 'Tab');
    expect(document.activeElement?.id).toBe('inside-first');
  });

  it('skips disabled focusables while cycling', () => {
    renderProbe(true);
    const input = document.getElementById('inside-input');
    const last = document.getElementById('inside-last');
    if (!input || !last) throw new Error('focusables missing');
    // The trap's boundary list must exclude the disabled button, so Tab from
    // the input (now the effective last focusable) wraps to the first.
    (last as HTMLButtonElement).disabled = true;
    input.focus();
    keydown(input, 'Tab');
    expect(document.activeElement?.id).toBe('inside-first');
  });

  it('restores focus to the previously focused element on close', () => {
    const outside = document.createElement('button');
    outside.id = 'previously-focused';
    document.body.append(outside);
    outside.focus();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    act(() => root.render(<Probe active />));
    act(() => root.render(<Probe active={false} />));
    expect(document.activeElement?.id).toBe('previously-focused');
  });

  it('does nothing while inactive', () => {
    renderProbe(false);
    const outside = document.getElementById('outside-first');
    if (!outside) throw new Error('outside button missing');
    outside.focus();
    keydown(outside, 'Tab');
    // No trap listener is bound while inactive, so focus is untouched
    // (jsdom itself never moves focus on Tab).
    expect(document.activeElement?.id).toBe('outside-first');
  });
});
