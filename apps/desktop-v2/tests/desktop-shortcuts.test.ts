import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseDesktopCommand } from '../src/desktop-commands';
import { functionKeyTarget, isTypingTarget, shortcutGroups } from '../src/desktop-shortcuts';
import { ShortcutsOverlay } from '../src/ShortcutsOverlay';

describe('desktop keyboard shortcuts', () => {
  it('opens with each function key what its slash command opens', () => {
    expect(functionKeyTarget('F2')).toEqual({ page: 'live-fleet' });
    expect(functionKeyTarget('F5')).toEqual({ tab: 'plan' });
    expect(functionKeyTarget('F8')).toEqual({ tab: 'processes' });
    expect(functionKeyTarget('F11')).toEqual({ page: 'office' });
    expect(functionKeyTarget('F1')).toBeUndefined();
    expect(functionKeyTarget('F12')).toBeUndefined();
    const views = shortcutGroups().find((group) => group.title === 'Views')?.shortcuts ?? [];
    expect(views.map((shortcut) => shortcut.keys[0])).toEqual([
      'F2',
      'F3',
      'F4',
      'F5',
      'F8',
      'F9',
      'F10',
      'F11',
    ]);
    for (const shortcut of views) expect(functionKeyTarget(shortcut.keys[0]!)).toBeDefined();
  });

  it('lists the function keys with their commands’ descriptions', () => {
    const views = shortcutGroups().find((group) => group.title === 'Views');
    expect(views?.shortcuts.find((shortcut) => shortcut.keys[0] === 'F4')?.description).toBe(
      parseDesktopCommand('/worktree')?.command?.description,
    );
    const html = renderToStaticMarkup(createElement(ShortcutsOverlay, { onClose: () => {} }));
    expect(html).toContain('Keyboard shortcuts');
    expect(html).toContain('<kbd>Ctrl</kbd>');
    expect(html).toContain('Stop the running turn (in the composer)');
  });

  it('treats text fields as typing, so plain keys stay text there', () => {
    expect(isTypingTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'input' } as unknown as EventTarget)).toBe(true);
    expect(
      isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget),
    ).toBe(true);
    expect(isTypingTarget({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
