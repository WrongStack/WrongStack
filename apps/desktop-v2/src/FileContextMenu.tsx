import { type ReactNode, useLayoutEffect, useRef } from 'react';

/**
 * A pointer-positioned context menu that owns the keyboard while open: the first item takes
 * focus, arrow keys / Home / End move between items, Escape or Tab closes it, and focus returns
 * to whatever had it before the menu opened. A click outside closes it as well.
 */
export function FileContextMenu({
  label,
  x,
  y,
  onClose,
  children,
}: {
  label: string;
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);
  useLayoutEffect(() => {
    opener.current = document.activeElement;
    box.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => {
      // Only hand focus back when it is still inside the menu (an action may have moved it on).
      const target = opener.current;
      if (
        target instanceof HTMLElement &&
        target.isConnected &&
        (!document.activeElement ||
          document.activeElement === document.body ||
          box.current?.contains(document.activeElement))
      )
        target.focus();
    };
  }, []);
  const move = (step: number | 'first' | 'last') => {
    const items = [
      ...(box.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
    ];
    if (!items.length) return;
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      step === 'first'
        ? 0
        : step === 'last'
          ? items.length - 1
          : (at + step + items.length) % items.length;
    items[next]?.focus();
  };
  return (
    <>
      <button
        type="button"
        className="file-context-dismiss"
        aria-label="Close file menu"
        tabIndex={-1}
        onClick={onClose}
      />
      <div
        ref={box}
        className="file-context-menu"
        role="menu"
        aria-label={label}
        tabIndex={-1}
        style={{ left: x, top: y }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' || event.key === 'Tab') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            move(1);
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            move(-1);
          } else if (event.key === 'Home') {
            event.preventDefault();
            move('first');
          } else if (event.key === 'End') {
            event.preventDefault();
            move('last');
          }
        }}
      >
        {children}
      </div>
    </>
  );
}
