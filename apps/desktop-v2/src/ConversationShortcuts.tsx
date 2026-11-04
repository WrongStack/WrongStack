import { useEffect, useRef, useState } from 'react';
import type { DesktopNavigation } from './desktop-commands';
import { functionKeyTarget, isTypingTarget } from './desktop-shortcuts';
import { ShortcutsOverlay } from './ShortcutsOverlay';

/**
 * The open conversation's keyboard shortcuts: function keys open the views the WebUI's F-key
 * panels show, Ctrl+/ focuses the composer, and `?` or F1 lists every shortcut. Returns the
 * overlay to render.
 */
export function useConversationShortcuts(navigate: (target: DesktopNavigation) => void) {
  const [open, setOpen] = useState(false);
  const go = useRef(navigate);
  go.current = navigate;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      // A modal dialog owns the keyboard.
      if (document.querySelector('dialog[open]')) return;
      const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
      const target = plain ? functionKeyTarget(event.key) : undefined;
      if (target) {
        event.preventDefault();
        go.current(target);
      } else if (
        plain &&
        (event.key === 'F1' || (event.key === '?' && !isTypingTarget(event.target)))
      ) {
        event.preventDefault();
        setOpen(true);
      } else if ((event.ctrlKey || event.metaKey) && event.key === '/') {
        event.preventDefault();
        // By its container, not its accessible name: that name follows the display language.
        document.querySelector<HTMLTextAreaElement>('.composer-input textarea')?.focus();
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);
  return open ? <ShortcutsOverlay onClose={() => setOpen(false)} /> : null;
}
