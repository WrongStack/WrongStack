import { type ReactNode, type RefObject, useLayoutEffect, useRef } from 'react';

/** Whether a pointer position lies outside a dialog's box (on its backdrop). */
export function outsideBox(
  box: { left: number; top: number; right: number; bottom: number },
  x: number,
  y: number,
): boolean {
  return x < box.left || x > box.right || y < box.top || y > box.bottom;
}

export function Modal({
  children,
  onClose,
  title,
  className,
  initialFocus,
}: {
  children: ReactNode;
  onClose: () => void;
  title?: string;
  className?: string | undefined;
  initialFocus?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // A backdrop click closes like Escape only when it also started on the backdrop, so a text
  // selection dragged out of the dialog does not close it.
  const pressedOutside = useRef(false);
  // Layout effects run while the dialog is still in the document: the opener is captured
  // before showModal moves focus, and focus goes back to it before the dialog is removed.
  // A passive effect would close an already detached dialog and leave focus on the body.
  useLayoutEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    initialFocus?.current?.focus();
    return () => {
      dialog?.close();
      if (!opener?.isConnected) return;
      opener.focus();
      if (document.activeElement !== opener) {
        // A busy opener can become enabled later in the same React commit.
        queueMicrotask(() => {
          if (opener.isConnected && document.activeElement === document.body) opener.focus();
        });
      }
    };
  }, [initialFocus]);
  const onBackdrop = (event: { target: EventTarget; clientX: number; clientY: number }) =>
    event.target === ref.current &&
    outsideBox(ref.current.getBoundingClientRect(), event.clientX, event.clientY);
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape (onCancel) is the keyboard path to the same close.
    <dialog
      ref={ref}
      className={className ? `modal ${className}` : 'modal'}
      aria-labelledby={title ? undefined : 'dialog-title'}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onMouseDown={(event) => {
        pressedOutside.current = onBackdrop(event);
      }}
      onClick={(event) => {
        if (pressedOutside.current && onBackdrop(event)) onClose();
        pressedOutside.current = false;
      }}
    >
      {children}
    </dialog>
  );
}
