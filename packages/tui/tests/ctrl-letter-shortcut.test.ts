// Regression test for Ink 7 control-character key delivery.
//
// Ink 7's `useInput` callback receives control characters (\x01-\x1f) as
// fully-formed events: `input` is the corresponding letter and `key.ctrl`
// is true. (Earlier concern that Ink stripped the letter from `input` and
// left only `key.ctrl=true, input=''` turned out to be incorrect for the
// real Ink 7 we ship — see the historical discussion in commit history.)
//
// The app-side matchers in handleKey (e.g. `key.ctrl && input === 'v'`)
// branch on `input === '<letter>'`, so they fire correctly today. This
// test pins the contract so a future Ink upgrade that DOES strip the
// letter (or a future code change that relies on the broken shape) will
// fail loudly.
//
// What we assert:
//   - \x16 (Ctrl+V) → onKey('v', { ctrl: true })
//   - \x01 (Ctrl+A) → onKey('a', { ctrl: true })
//   - \x0b (Ctrl+K) → onKey('k', { ctrl: true })
//   - \x08 (Backspace / Ctrl+H byte) → onKey with backspace=true,
//     NOT onKey('h', { ctrl: true }) — Backspace branch wins because
//     it's matched first in the raw-stdin handler.
//
// If a future change makes any of these regress, the matching handleKey
// branch (e.g. Ctrl+V → paste) will silently stop working. This test
// catches that before it ships.

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Input, type KeyEvent } from '../src/components/input.js';

function makeCapture() {
  const calls: Array<{ input: string; key: KeyEvent }> = [];
  const onKey = (input: string, key: KeyEvent) => {
    calls.push({ input, key });
  };
  return { calls, onKey };
}

describe('<Input /> Ctrl+letter shortcut (Ink 7 key delivery)', () => {
  it('forwards \\x16 (Ctrl+V) as onKey("v", { ctrl: true })', async () => {
    const { calls, onKey } = makeCapture();
    const { stdin, unmount } = render(React.createElement(Input, { value: '', cursor: 0, onKey }));

    stdin.write('\x16');
    await new Promise((resolve) => setImmediate(resolve));

    const ctrlV = calls.find((c) => c.input === 'v' && c.key.ctrl === true);
    expect(ctrlV, 'expected onKey("v", { ctrl: true }) for \\x16').toBeDefined();

    unmount();
  });

  it('forwards \\x01 (Ctrl+A) as onKey("a", { ctrl: true })', async () => {
    const { calls, onKey } = makeCapture();
    const { stdin, unmount } = render(React.createElement(Input, { value: '', cursor: 0, onKey }));

    stdin.write('\x01');
    await new Promise((resolve) => setImmediate(resolve));

    const ctrlA = calls.find((c) => c.input === 'a' && c.key.ctrl === true);
    expect(ctrlA, 'expected onKey("a", { ctrl: true }) for \\x01').toBeDefined();

    unmount();
  });

  it('forwards \\x0b (Ctrl+K) as onKey("k", { ctrl: true })', async () => {
    const { calls, onKey } = makeCapture();
    const { stdin, unmount } = render(React.createElement(Input, { value: '', cursor: 0, onKey }));

    stdin.write('\x0b');
    await new Promise((resolve) => setImmediate(resolve));

    const ctrlK = calls.find((c) => c.input === 'k' && c.key.ctrl === true);
    expect(ctrlK, 'expected onKey("k", { ctrl: true }) for \\x0b').toBeDefined();

    unmount();
  });

  it('treats \\x08 as Backspace, not as Ctrl+H', async () => {
    const { calls, onKey } = makeCapture();
    const { stdin, unmount } = render(React.createElement(Input, { value: '', cursor: 0, onKey }));

    stdin.write('\x08');
    await new Promise((resolve) => setImmediate(resolve));

    const backspace = calls.find((c) => c.key.backspace === true);
    expect(backspace, 'expected onKey with backspace=true for \\x08').toBeDefined();
    const falseCtrlH = calls.find((c) => c.input === 'h' && c.key.ctrl === true);
    expect(falseCtrlH, '\\x08 must NOT be misclassified as Ctrl+H').toBeUndefined();

    unmount();
  });

  it('forwards raw Ctrl+Left and Ctrl+Right escape sequences', async () => {
    const { calls, onKey } = makeCapture();
    const { stdin, unmount } = render(
      React.createElement(Input, { value: 'hello world', cursor: 5, onKey }),
    );

    stdin.write('\x1b[1;5D');
    stdin.write('\x1b[1;5C');
    await new Promise((resolve) => setImmediate(resolve));

    expect(calls.some((c) => c.key.ctrl && c.key.leftArrow)).toBe(true);
    expect(calls.some((c) => c.key.ctrl && c.key.rightArrow)).toBe(true);

    unmount();
  });
});
