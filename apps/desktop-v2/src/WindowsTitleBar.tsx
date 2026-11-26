import { isTauri } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useEffect, useRef, useState } from 'react';
import './windows-title-bar.css';

/**
 * Windows-only custom caption for the desktop shell.
 *
 * After the frontend mounts, the Tauri bridge removes the native decorations
 * (`setDecorations(false)`) and this header takes over dragging
 * (`data-tauri-drag-region`), minimize, maximize/restore and close. Close uses
 * the normal close-requested path, so the native window lifecycle (geometry
 * persistence on CloseRequested) is unchanged.
 *
 * Fallback: on non-Windows hosts, outside the Tauri bridge, and whenever a
 * bridge call fails (including preview windows, which hold no capabilities),
 * nothing renders and the native caption stays.
 *
 * `onActiveChange` reports whether the custom chrome is enabled: `true` once
 * the decorations are removed and the controls are live, `false` on rollback
 * when a partially activated setup had to restore the native caption. The
 * shell wires its offsets from this state; window focus stays internal here
 * and only drives the inactive styling.
 */
// Per-window serialization of every decoration change: a restore scheduled by
// a cleanup always settles before the next activation starts, so unmount and
// StrictMode's phantom mount can never interleave bridge calls.
let sequence: Promise<unknown> = Promise.resolve();

export function WindowsTitleBar({ onActiveChange }: { onActiveChange: (active: boolean) => void }) {
  const [active, setActive] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [focused, setFocused] = useState(true);
  const activeChangeRef = useRef(onActiveChange);
  useEffect(() => {
    activeChangeRef.current = onActiveChange;
  });

  useEffect(() => {
    if (!isTauri() || !navigator.userAgent.includes('Windows NT')) return;
    let win: ReturnType<typeof getCurrentWindow>;
    try {
      win = getCurrentWindow();
    } catch {
      return; // The renderer may have no window metadata (e.g. a preview bridge).
    }
    let disposed = false;
    // Set only after the bridge confirmed the decorations are gone; restores
    // run only from this state, so the phantom StrictMode cleanup (which runs
    // before the bridge resolves) never races the real mount's activation.
    let activated = false;
    const unlisteners: Array<() => void> = [];

    const release = async () => {
      for (const unlisten of unlisteners.splice(0)) unlisten();
      // When the window is closing this rejection is expected and harmless.
      await win.setDecorations(true).catch(() => {});
    };

    const run = sequence.then(async () => {
      // A mount disposed before the queue reached it never touches the window.
      if (disposed) return;
      try {
        await win.setDecorations(false);
        // Claim the removal before any exit check: a cleanup that already ran
        // queued its restore behind this task and must see `activated` to give
        // the native caption back.
        activated = true;
        if (disposed) return;
        const [maximizedNow, focusedNow] = await Promise.all([win.isMaximized(), win.isFocused()]);
        if (disposed) return;
        setMaximized(maximizedNow);
        setFocused(focusedNow);
        // Push each unlisten as it resolves so a failure below still releases
        // the listeners that already registered.
        unlisteners.push(
          await win.onResized(
            () =>
              void win
                .isMaximized()
                .then(setMaximized)
                .catch(() => {}),
          ),
        );
        unlisteners.push(
          await win.onFocusChanged((event) => {
            setFocused(event.payload);
          }),
        );
        // The queued cleanup restore releases these once it sees `activated`.
        if (disposed) return;
        setActive(true);
        activeChangeRef.current(true);
      } catch {
        // Failed initialization: an untouched native caption needs no rollback;
        // a partially activated one does, before the shell falls back.
        if (activated) {
          await release();
          if (!disposed) {
            setActive(false);
            activeChangeRef.current(false);
          }
        }
      }
    });
    sequence = run.catch(() => {});

    return () => {
      disposed = true;
      // The restore is queued behind the activation, so it lands after the
      // bridge settled and before any later mount re-activates.
      sequence = sequence.then(() => (activated ? release() : undefined));
    };
  }, []);

  if (!active) return null;
  return (
    <section
      className={focused ? 'desktop-titlebar' : 'desktop-titlebar desktop-titlebar--inactive'}
      aria-label="Window controls"
    >
      <div className="desktop-titlebar-title" data-tauri-drag-region>
        {document.title}
      </div>
      <div className="desktop-titlebar-drag" data-tauri-drag-region aria-hidden="true" />
      <div className="desktop-titlebar-controls">
        <button
          type="button"
          className="desktop-titlebar-button"
          title="Minimize"
          aria-label="Minimize"
          onClick={() =>
            void getCurrentWindow()
              .minimize()
              .catch(() => {})
          }
        >
          <svg
            className="desktop-titlebar-glyph"
            viewBox="0 0 10 10"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth={1}
            shapeRendering="crispEdges"
          >
            <path d="M0 5h10" />
          </svg>
        </button>
        <button
          type="button"
          className="desktop-titlebar-button"
          title={maximized ? 'Restore' : 'Maximize'}
          aria-label={maximized ? 'Restore' : 'Maximize'}
          onClick={() =>
            void getCurrentWindow()
              .toggleMaximize()
              .catch(() => {})
          }
        >
          <svg
            className="desktop-titlebar-glyph"
            viewBox="0 0 10 10"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth={1}
            shapeRendering="crispEdges"
          >
            {maximized ? (
              <>
                <path d="M2.5 2.5V0.5h7v7H7.5" />
                <path d="M0.5 2.5h7v7h-7z" />
              </>
            ) : (
              <path d="M0.5 0.5h9v9h-9z" />
            )}
          </svg>
        </button>
        <button
          type="button"
          className="desktop-titlebar-button desktop-titlebar-button--close"
          title="Close"
          aria-label="Close"
          onClick={() =>
            void getCurrentWindow()
              .close()
              .catch(() => {})
          }
        >
          <svg
            className="desktop-titlebar-glyph"
            viewBox="0 0 10 10"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth={1}
          >
            <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />
          </svg>
        </button>
      </div>
    </section>
  );
}
