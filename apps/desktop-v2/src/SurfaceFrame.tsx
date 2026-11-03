import type { ConfirmOptions, SurfaceHost } from '@wrongstack/project-surfaces/host';
import { SurfaceHostProvider } from '@wrongstack/project-surfaces/host';
import { Button } from '@wrongstack/project-surfaces/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@wrongstack/project-surfaces/ui/dialog';
import { SurfacePortalContext } from '@wrongstack/project-surfaces/ui/portal';
import { type ReactNode, useCallback, useState } from 'react';
import { createPortal } from 'react-dom';
import { I18nextProvider } from 'react-i18next';
import { surfaceI18n } from './surface-i18n';
import './surfaces.css';

type PendingConfirm = { options: ConfirmOptions; resolve: (confirmed: boolean) => void };

/** A promise-based confirm for a host, shown by the frame that owns it. */
export function useSurfaceConfirm() {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setPending({ options, resolve })),
    [],
  );
  const settle = (confirmed: boolean) => {
    pending?.resolve(confirmed);
    setPending(null);
  };
  return { confirm, pending, settle };
}

/**
 * The container every shared project surface renders in: the WebUI theme tokens apply only
 * inside it and inside its dialog root, and its strings come from the WebUI catalogs.
 */
export function SurfaceFrame({
  host,
  confirm,
  fill = false,
  children,
}: {
  host: SurfaceHost;
  confirm: ReturnType<typeof useSurfaceConfirm>;
  /** Fills the project page edge to edge instead of scrolling inside its padding (canvases). */
  fill?: boolean;
  children: ReactNode;
}) {
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  const pending = confirm.pending;
  return (
    <I18nextProvider i18n={surfaceI18n}>
      <SurfaceHostProvider host={host}>
        <SurfacePortalContext.Provider value={portal}>
          <div className={`ws-surfaces ws-surface-frame${fill ? ' is-fill' : ''}`}>{children}</div>
          {createPortal(<div className="ws-surfaces" ref={setPortal} />, document.body)}
          <Dialog open={pending !== null} onOpenChange={(open) => !open && confirm.settle(false)}>
            {pending && (
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{pending.options.title}</DialogTitle>
                  {pending.options.message && (
                    <DialogDescription>{pending.options.message}</DialogDescription>
                  )}
                </DialogHeader>
                {pending.options.details && (
                  <ul className="list-disc pl-5 text-sm text-muted-foreground">
                    {pending.options.details.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                )}
                <DialogFooter>
                  <Button variant="outline" onClick={() => confirm.settle(false)}>
                    {pending.options.cancelLabel ?? 'Cancel'}
                  </Button>
                  <Button
                    variant={pending.options.danger ? 'destructive' : 'default'}
                    onClick={() => confirm.settle(true)}
                  >
                    {pending.options.confirmLabel ?? 'Confirm'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            )}
          </Dialog>
        </SurfacePortalContext.Provider>
      </SurfaceHostProvider>
    </I18nextProvider>
  );
}
