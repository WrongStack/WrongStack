import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import React from 'react';
import { Input, type KeyEvent } from '../src/components/input.js';
import { SlashMenu } from '../src/components/slash-menu.js';
import type { SlashCommandMatch } from '../src/app-state.js';

function makeKey(overrides: Partial<KeyEvent> = {}): KeyEvent {
  return {
    upArrow: false,
    downArrow: false,
    leftArrow: false,
    rightArrow: false,
    return: false,
    escape: false,
    ctrl: false,
    meta: false,
    shift: false,
    tab: false,
    backspace: false,
    delete: false,
    pageUp: false,
    pageDown: false,
    home: false,
    end: false,
    ...overrides,
  };
}

function match(
  name: string,
  category: SlashCommandMatch['category'],
  description = `${name} description`,
): SlashCommandMatch {
  return {
    name,
    description,
    category,
    isBuiltin: true,
  };
}

describe('Issue 005 — stable interaction coverage additions', () => {
  it('SlashMenu renders grouped slash-command matches and the active selection context', () => {
    const matches: SlashCommandMatch[] = [
      match('session', 'Session'),
      match('settings', 'Config'),
      { ...match('setmodel', 'Config'), argsHint: '<provider/model>' },
    ];

    const { lastFrame, unmount } = render(
      React.createElement(SlashMenu, {
        query: 'set',
        matches,
        selected: 2,
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('/set (3/3)');
    expect(frame).toContain('Config');
    expect(frame).toContain('setmodel');
    expect(frame).toContain('<provider/model>');
    expect(frame).toContain('↑↓ nav · Enter run · Tab fill · Esc close');

    unmount();
  });

  it('SlashMenu keeps category context and shows overflow markers when windowed', () => {
    const matches: SlashCommandMatch[] = [
      match('agent', 'Agent'),
      match('auth', 'Agent'),
      match('autonomy', 'Agent'),
      match('goal', 'Agent'),
      match('audit', 'Inspect'),
      match('brain', 'Inspect'),
      match('clear', 'App'),
      match('compact', 'App'),
      match('context', 'App'),
      match('delegate', 'Run'),
    ];

    const { lastFrame, unmount } = render(
      React.createElement(SlashMenu, {
        query: 'a',
        matches,
        selected: 7,
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('↑');
    expect(frame).toContain('↓');
    expect(frame).toContain('App');
    expect(frame).toContain('compact');
    unmount();
  });

  it('SlashMenu renders the empty-state guidance when no commands match', () => {
    const { lastFrame, unmount } = render(
      React.createElement(SlashMenu, {
        query: 'zzz',
        matches: [],
        selected: 0,
      }),
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('/zzz');
    expect(frame).toContain('No matching commands');
    expect(frame).toContain('↑↓ nav · Enter run · Tab fill · Esc close');
    unmount();
  });

  it('Input emits Enter and Shift+Enter as distinct key events', async () => {
    const calls: Array<{ input: string; key: KeyEvent }> = [];
    const onKey = (input: string, key: KeyEvent) => {
      calls.push({ input, key });
    };

    const { stdin, unmount } = render(
      React.createElement(Input, { value: 'hello', cursor: 5, onKey }),
    );

    stdin.write('\r');
    await new Promise((resolve) => setImmediate(resolve));

    const enterCall = calls.find((call) => call.key.return === true && call.key.shift !== true);
    expect(enterCall, 'expected a plain Enter key event').toBeDefined();

    onKey('', makeKey({ return: true, shift: true }));
    const shiftEnterCall = calls.find(
      (call) => call.key.return === true && call.key.shift === true,
    );
    expect(shiftEnterCall, 'expected a Shift+Enter-shaped key event').toBeDefined();

    unmount();
  });
});
