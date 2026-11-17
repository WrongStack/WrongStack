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
  summary,
  children,
}: {
  className?: string | undefined;
  /** Opens it from outside (a live run); left out, the reader opens and closes it. */
  open?: boolean | undefined;
  /** The `<summary>` element. */
  summary: ReactNode;
  children: ReactNode;
}) {
  const eager = useContext(EagerDetails);
  const [built, setBuilt] = useState(open === true);
  useEffect(() => {
    if (open) setBuilt(true);
  }, [open]);
  return (
    <details
      className={className}
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open) setBuilt(true);
      }}
    >
      {summary}
      {(built || eager) && children}
    </details>
  );
}
