'use client';

import { useEffect, useRef } from 'react';
import { escapeClosesPanels } from './component-guards';

export type WorkspaceShortcut = 'commands' | 'search' | 'settings' | 'close-panels';

interface ShortcutEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  target: unknown;
}

/**
 * Maps a document keydown to a workspace shortcut. Ctrl and Cmd are equivalent.
 * `dialogOpen` suppresses every shortcut: an open dialog owns the keyboard.
 * Escape typed into a field belongs to that field (see escapeClosesPanels).
 */
export function shortcutFor(event: ShortcutEvent, dialogOpen: boolean): WorkspaceShortcut | null {
  if (event.defaultPrevented || dialogOpen) return null;
  const mod = event.metaKey || event.ctrlKey;
  const key = event.key.toLowerCase();
  // Ctrl/Cmd+P (with or without Shift) opens the palette; only Ctrl/Cmd+Shift+F searches.
  if (mod && key === 'p') return 'commands';
  if (mod && event.shiftKey && key === 'f') return 'search';
  if (mod && event.key === ',') return 'settings';
  if (escapeClosesPanels(event)) return 'close-panels';
  return null;
}

/** Shortcuts that take over the browser default (print, find, …). */
const PREVENT_DEFAULT: ReadonlySet<WorkspaceShortcut> = new Set(['commands', 'search', 'settings']);

/**
 * Document-level workspace shortcuts. The handler map may change every render;
 * the listener is registered once and always calls the latest handlers.
 */
export function useWorkspaceShortcuts(handlers: Record<WorkspaceShortcut, () => void>): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const shortcut = shortcutFor(event, Boolean(document.querySelector('.modal-content')));
      if (!shortcut) return;
      if (PREVENT_DEFAULT.has(shortcut)) event.preventDefault();
      latest.current[shortcut]();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}
