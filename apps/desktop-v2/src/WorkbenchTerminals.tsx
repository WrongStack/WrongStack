import { PanelBottom, PanelTop, Terminal } from 'lucide-react';
import { lazy, Suspense, useId, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDesktopText } from './desktop-i18n';
import { isLive, type Session, sessionTitle } from './model';
import './terminal-dock.css';

const TerminalPane = lazy(() =>
  import('./TerminalPane').then((module) => ({ default: module.TerminalPane })),
);

export type TerminalTabPlacement = {
  setSlot: (node: HTMLDivElement | null) => void;
  dock: (() => void) | undefined;
  dockButtonRef?: (button: HTMLButtonElement | null) => void;
  docked: boolean;
};

// Keep the portal target constant. Moving its host between slots does not unmount xterm,
// recreate the subscription, or reset the scrollback buffer.
export function HostedTerminal({
  session,
  slot,
  onError,
  autoFocus,
}: {
  session: Session;
  slot: HTMLDivElement | null;
  onError: (error: unknown) => void;
  autoFocus: boolean;
}) {
  const { t } = useDesktopText();
  const [host] = useState(() => {
    const node = document.createElement('div');
    node.className = 'workbench-terminal-host';
    return node;
  });
  const [attached, setAttached] = useState(false);
  useLayoutEffect(() => {
    if (!slot) return;
    slot.append(host);
    setAttached(true);
    return () => host.remove();
  }, [host, slot]);
  if (!attached) return null;
  return createPortal(
    <Suspense fallback={<div className="runtime-state">{t('workbench.openingTerminal')}</div>}>
      <TerminalPane
        id={session.id}
        writable={isLive(session)}
        onError={onError}
        autoFocus={autoFocus}
      />
    </Suspense>,
    host,
  );
}

export function TerminalDock({
  session,
  open,
  setSlot,
  toggle,
  undock,
  toggleButtonRef,
}: {
  session: Session;
  open: boolean;
  toggleButtonRef: (button: HTMLButtonElement | null) => void;
  setSlot: (node: HTMLDivElement | null) => void;
  toggle: () => void;
  undock: () => void;
}) {
  const { t } = useDesktopText();
  const id = useId();
  return (
    <section className="terminal-dock" aria-label="Terminal panel">
      <header>
        <Terminal className="terminal-dock-icon" size={15} aria-hidden="true" />
        <strong title={session.title}>{sessionTitle(session, t('workbench.untitled'))}</strong>
        <button
          type="button"
          className="icon-button"
          aria-expanded={open}
          aria-controls={id}
          ref={toggleButtonRef}
          aria-label={open ? 'Hide terminal panel' : 'Show terminal panel'}
          title={open ? 'Hide terminal panel' : 'Show terminal panel'}
          onClick={toggle}
        >
          <PanelBottom size={16} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Move terminal to tab"
          title="Move terminal to tab"
          onClick={undock}
        >
          <PanelTop size={16} aria-hidden="true" />
        </button>
      </header>
      <div id={id} className="terminal-dock-slot" ref={setSlot} hidden={!open} />
    </section>
  );
}
