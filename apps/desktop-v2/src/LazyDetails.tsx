import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';

/** Builds every body at once: for markup snapshots (tests, exports) that read what is inside. */
export const EagerDetails = createContext(false);

/**
 * A `<details>` whose body is built the first time it opens. A closed `<details>` still keeps
 * its whole body in the document: a conversation's run activity (every tool call with its
 * input, output and overview) reached thousands of nodes per turn while collapsed, and opening
 * the conversation spent over 100 ms building what nobody had opened. Once opened, the body
 * stays, so its own state (scroll, expanded parts) survives closing it again.
 */
export function LazyDetails({
  className,
  open,
  defaultOpen = false,
  onOpenChange,
  summary,
  children,
}: {
  className?: string | undefined;
  /** Controlled expansion. Omit to let the reader own this disclosure. */
  open?: boolean | undefined;
  /** Initial expansion only; later lifecycle updates never override the reader. */
  defaultOpen?: boolean | undefined;
  onOpenChange?: ((open: boolean) => void) | undefined;
  /** The `<summary>` element. */
  summary: ReactNode;
  children: ReactNode;
}) {
  const eager = useContext(EagerDetails);
  const [expanded, setExpanded] = useState(defaultOpen);
  const isOpen = open ?? expanded;
  const [built, setBuilt] = useState(isOpen);
  useEffect(() => {
    if (isOpen) setBuilt(true);
  }, [isOpen]);
  return (
    <details
      className={className}
      open={isOpen}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        if (next) setBuilt(true);
        if (next === isOpen) return;
        if (open === undefined) setExpanded(next);
        else event.currentTarget.open = open;
        onOpenChange?.(next);
      }}
    >
      {summary}
      {(built || eager) && children}
    </details>
  );
}
