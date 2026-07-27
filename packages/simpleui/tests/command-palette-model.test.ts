import { describe, expect, it } from 'vitest';
import {
  commandPaletteItems,
  filterCommandPaletteItems,
} from '../src/lib/command-palette-model.js';

const readyContext = {
  hasSession: true,
  running: false,
  canCompose: true,
  canCompact: true,
};

describe('command palette model', () => {
  it('builds core commands from current session state', () => {
    const items = commandPaletteItems(readyContext);
    expect(items.map((item) => item.id)).toContain('new-session');
    expect(items.map((item) => item.id)).toContain('open-memory');
    expect(items.find((item) => item.id === 'new-session')?.disabled).toBe(false);
  });

  it('disables commands that are unsafe for the current state', () => {
    const items = commandPaletteItems({
      hasSession: false,
      running: true,
      canCompose: false,
      canCompact: false,
    });
    expect(items.find((item) => item.id === 'new-session')?.disabled).toBe(true);
    expect(items.find((item) => item.id === 'focus-composer')?.disabled).toBe(true);
    expect(items.find((item) => item.id === 'compact-context')?.disabled).toBe(true);
    expect(items.find((item) => item.id === 'open-settings')?.disabled).toBeFalsy();
  });

  it('filters by title, section, hint, and keywords', () => {
    const items = commandPaletteItems(readyContext);
    expect(filterCommandPaletteItems(items, 'memory').map((item) => item.id)).toEqual(['open-memory']);
    expect(filterCommandPaletteItems(items, 'ctrl+l').map((item) => item.id)).toEqual(['new-session']);
    expect(filterCommandPaletteItems(items, 'workspace plan').map((item) => item.id)).toEqual(['open-plan']);
  });
});
