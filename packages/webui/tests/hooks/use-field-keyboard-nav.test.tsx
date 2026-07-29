import { describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useFieldKeyboardNav } from '../../src/hooks/useFieldKeyboardNav';

type Nav = ReturnType<typeof useFieldKeyboardNav>;

/** Build a keyboard event stub with a spy-able preventDefault. */
function keyEvent(key: string) {
  return {
    key,
    preventDefault: vi.fn(),
  } as unknown as React.KeyboardEvent;
}

function input(value = 'hello'): HTMLInputElement {
  const el = document.createElement('input');
  el.value = value;
  document.body.appendChild(el);
  return el;
}

function textarea(value = 'multi\nline'): HTMLTextAreaElement {
  const el = document.createElement('textarea');
  el.value = value;
  document.body.appendChild(el);
  return el;
}

function button(): HTMLButtonElement {
  const el = document.createElement('button');
  document.body.appendChild(el);
  return el;
}

/** Register a list of elements as fields 0..n-1. */
function register(nav: Nav, els: Array<HTMLElement | null>) {
  els.forEach((el, i) => {
    nav.setFieldRef(i)(el);
  });
}

function setup() {
  const { result } = renderHook(() => useFieldKeyboardNav());
  return result;
}

describe('useFieldKeyboardNav', () => {
  it('returns a stable setFieldRef/handleKeyDown pair across re-renders', () => {
    const { result, rerender } = renderHook(() => useFieldKeyboardNav());
    const first = result.current;
    rerender();
    expect(result.current.setFieldRef).toBe(first.setFieldRef);
    expect(result.current.handleKeyDown).toBe(first.handleKeyDown);
  });

  describe('ArrowDown', () => {
    it('moves focus to the next registered field', () => {
      const nav = setup();
      const [a, b] = [input(), input()];
      register(nav.current, [a, b]);
      nav.current.handleKeyDown(keyEvent('ArrowDown'), 0);
      expect(document.activeElement).toBe(b);
    });

    it('preventDefaults so the page does not scroll', () => {
      const nav = setup();
      register(nav.current, [input(), input()]);
      const e = keyEvent('ArrowDown');
      nav.current.handleKeyDown(e, 0);
      expect(e.preventDefault).toHaveBeenCalled();
    });

    it('places the caret at the end of the newly focused input', () => {
      const nav = setup();
      const [a, b] = [input('abc'), input('hello world')];
      register(nav.current, [a, b]);
      nav.current.handleKeyDown(keyEvent('ArrowDown'), 0);
      expect(b.selectionStart).toBe(11);
      expect(b.selectionEnd).toBe(11);
    });

    it('places the caret at the end of a textarea too', () => {
      const nav = setup();
      const [a, b] = [input(), textarea('one\ntwo')];
      register(nav.current, [a, b]);
      nav.current.handleKeyDown(keyEvent('ArrowDown'), 0);
      expect(b.selectionStart).toBe(7);
    });

    it('focuses a non-text element without touching selection', () => {
      const nav = setup();
      const [a, b] = [input(), button()];
      register(nav.current, [a, b]);
      expect(() => nav.current.handleKeyDown(keyEvent('ArrowDown'), 0)).not.toThrow();
      expect(document.activeElement).toBe(b);
    });

    it('skips a disabled field', () => {
      const nav = setup();
      const [a, b, c] = [input(), input(), input()];
      b.setAttribute('disabled', '');
      register(nav.current, [a, b, c]);
      nav.current.handleKeyDown(keyEvent('ArrowDown'), 0);
      expect(document.activeElement).toBe(c);
    });

    it('skips an aria-disabled field', () => {
      const nav = setup();
      const [a, b, c] = [input(), input(), input()];
      b.setAttribute('aria-disabled', 'true');
      register(nav.current, [a, b, c]);
      nav.current.handleKeyDown(keyEvent('ArrowDown'), 0);
      expect(document.activeElement).toBe(c);
    });

    it('does not skip aria-disabled="false"', () => {
      const nav = setup();
      const [a, b] = [input(), input()];
      b.setAttribute('aria-disabled', 'false');
      register(nav.current, [a, b]);
      nav.current.handleKeyDown(keyEvent('ArrowDown'), 0);
      expect(document.activeElement).toBe(b);
    });

    it('skips a slot that was never registered (null ref)', () => {
      const nav = setup();
      const [a, c] = [input(), input()];
      register(nav.current, [a, null, c]);
      nav.current.handleKeyDown(keyEvent('ArrowDown'), 0);
      expect(document.activeElement).toBe(c);
    });

    it('stays put on the last field', () => {
      const nav = setup();
      const [a, b] = [input(), input()];
      register(nav.current, [a, b]);
      b.focus();
      nav.current.handleKeyDown(keyEvent('ArrowDown'), 1);
      expect(document.activeElement).toBe(b);
    });

    it('stays put when every field below is disabled', () => {
      const nav = setup();
      const [a, b] = [input(), input()];
      b.setAttribute('disabled', '');
      register(nav.current, [a, b]);
      a.focus();
      nav.current.handleKeyDown(keyEvent('ArrowDown'), 0);
      expect(document.activeElement).toBe(a);
    });
  });

  describe('ArrowUp', () => {
    it('moves focus to the previous registered field', () => {
      const nav = setup();
      const [a, b] = [input(), input()];
      register(nav.current, [a, b]);
      nav.current.handleKeyDown(keyEvent('ArrowUp'), 1);
      expect(document.activeElement).toBe(a);
    });

    it('preventDefaults', () => {
      const nav = setup();
      register(nav.current, [input(), input()]);
      const e = keyEvent('ArrowUp');
      nav.current.handleKeyDown(e, 1);
      expect(e.preventDefault).toHaveBeenCalled();
    });

    it('places the caret at the end of the previous input', () => {
      const nav = setup();
      const [a, b] = [input('abcdef'), input()];
      register(nav.current, [a, b]);
      nav.current.handleKeyDown(keyEvent('ArrowUp'), 1);
      expect(a.selectionStart).toBe(6);
    });

    it('skips disabled and aria-disabled fields upward', () => {
      const nav = setup();
      const [a, b, c, d] = [input(), input(), input(), input()];
      b.setAttribute('disabled', '');
      c.setAttribute('aria-disabled', 'true');
      register(nav.current, [a, b, c, d]);
      nav.current.handleKeyDown(keyEvent('ArrowUp'), 3);
      expect(document.activeElement).toBe(a);
    });

    it('skips an unregistered slot upward', () => {
      const nav = setup();
      const [a, c] = [input(), input()];
      register(nav.current, [a, null, c]);
      nav.current.handleKeyDown(keyEvent('ArrowUp'), 2);
      expect(document.activeElement).toBe(a);
    });

    it('stays put on the first field', () => {
      const nav = setup();
      const [a, b] = [input(), input()];
      register(nav.current, [a, b]);
      a.focus();
      nav.current.handleKeyDown(keyEvent('ArrowUp'), 0);
      expect(document.activeElement).toBe(a);
    });

    it('focuses a non-text element upward without touching selection', () => {
      const nav = setup();
      const [a, b] = [button(), input()];
      register(nav.current, [a, b]);
      nav.current.handleKeyDown(keyEvent('ArrowUp'), 1);
      expect(document.activeElement).toBe(a);
    });
  });

  describe('Enter', () => {
    it('invokes onEnter and preventDefaults', () => {
      const nav = setup();
      register(nav.current, [input()]);
      const onEnter = vi.fn();
      const e = keyEvent('Enter');
      nav.current.handleKeyDown(e, 0, onEnter);
      expect(onEnter).toHaveBeenCalledTimes(1);
      expect(e.preventDefault).toHaveBeenCalled();
    });

    it('is inert when no onEnter handler is supplied', () => {
      const nav = setup();
      register(nav.current, [input()]);
      const e = keyEvent('Enter');
      nav.current.handleKeyDown(e, 0);
      // Without a handler the event must reach the browser (form submit,
      // newline in a textarea) rather than being swallowed.
      expect(e.preventDefault).not.toHaveBeenCalled();
    });

    it('does not move focus', () => {
      const nav = setup();
      const [a, b] = [input(), input()];
      register(nav.current, [a, b]);
      a.focus();
      nav.current.handleKeyDown(keyEvent('Enter'), 0, vi.fn());
      expect(document.activeElement).toBe(a);
    });
  });

  describe('other keys', () => {
    it.each(['ArrowLeft', 'ArrowRight', 'Tab', 'a', 'Escape'])(
      'leaves %s to native handling',
      (key) => {
        const nav = setup();
        const [a, b] = [input(), input()];
        register(nav.current, [a, b]);
        a.focus();
        const e = keyEvent(key);
        nav.current.handleKeyDown(e, 0, vi.fn());
        expect(e.preventDefault).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(a);
      },
    );
  });

  describe('setFieldRef', () => {
    it('registers and then unregisters a field when React passes null', () => {
      const nav = setup();
      const [a, b, c] = [input(), input(), input()];
      register(nav.current, [a, b, c]);
      // Unmounting field 1 hands back a null ref.
      nav.current.setFieldRef(1)(null);
      nav.current.handleKeyDown(keyEvent('ArrowDown'), 0);
      expect(document.activeElement).toBe(c);
    });

    it('returns a new callback per index but keeps the same registry', () => {
      const nav = setup();
      const a = input();
      const ref0 = nav.current.setFieldRef(0);
      ref0(a);
      // Re-registering index 0 with a different element replaces it.
      const a2 = input();
      nav.current.setFieldRef(0)(a2);
      const b = input();
      nav.current.setFieldRef(1)(b);
      nav.current.handleKeyDown(keyEvent('ArrowUp'), 1);
      expect(document.activeElement).toBe(a2);
    });

    it('tolerates sparse registration (gaps between indices)', () => {
      const nav = setup();
      const a = input();
      const e = input();
      nav.current.setFieldRef(0)(a);
      nav.current.setFieldRef(4)(e);
      nav.current.handleKeyDown(keyEvent('ArrowDown'), 0);
      expect(document.activeElement).toBe(e);
    });

    it('is a no-op when nothing is registered at all', () => {
      const nav = setup();
      expect(() => nav.current.handleKeyDown(keyEvent('ArrowDown'), 0)).not.toThrow();
      expect(() => nav.current.handleKeyDown(keyEvent('ArrowUp'), 0)).not.toThrow();
    });
  });
});
