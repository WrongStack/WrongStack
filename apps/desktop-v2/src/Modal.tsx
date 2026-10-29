import { type ReactNode, useLayoutEffect, useRef } from 'react';

export function Modal({
  children,
  onClose,
  title,
}: {
  children: ReactNode;
  onClose: () => void;
  title?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Layout effects run while the dialog is still in the document: the opener is captured
  // before showModal moves focus, and focus goes back to it before the dialog is removed.
  // A passive effect would close an already detached dialog and leave focus on the body.
  useLayoutEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      aria-labelledby={title ? undefined : 'dialog-title'}
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      {children}
    </dialog>
  );
}
