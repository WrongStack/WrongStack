/**
 * `<ClearAllowlistDialog>` — confirmation modal for the destructive
 * "Clear allowlist" action on `<ProviderModelsPanel>`.
 *
 * The dialog runs before the WS round-trip — the user's accidental
 * click on a small ghost-variant button is one keystroke away from
 * losing the pinned model list, and one toast away from getting it
 * back. The modal is the first layer; the undo toast is the second.
 *
 * The dialog itself is purely presentational: the parent owns the
 * `open` flag and the `onConfirm` / `onCancel` callbacks. This keeps
 * the state machine trivially testable (the parent's
 * `useReducer(open, action)` is the single source of truth) and lets
 * the dialog be reused in any flow that needs the same confirmation
 * pattern.
 */
import { AlertTriangle } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useAppTranslation } from '@/i18n';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';

export interface ClearAllowlistDialogProps {
  open: boolean;
  providerId: string;
  /** How many ids will be removed. Used in the dialog body. */
  modelCount: number;
  /**
   * Called when the user confirms. The parent should fire the WS
   * round-trip and show the undo toast.
   */
  onConfirm: () => void;
  /**
   * Called when the user cancels (via the Cancel button, the Esc
   * key, or the dialog's X button). The parent should reset
   * `open` to `false`.
   */
  onCancel: () => void;
}

export function ClearAllowlistDialog({
  open,
  providerId,
  modelCount,
  onConfirm,
  onCancel,
}: ClearAllowlistDialogProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const { t } = useAppTranslation();

  // Keyboard shortcuts: Enter to confirm, Escape to cancel. Matches
  // the muscle memory of the existing `<ConfirmDialog>` and the
  // CLI's permission prompts (y/n).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    contentRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onConfirm, onCancel]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent
        className="sm:max-w-md border-warning/50"
        ref={contentRef}
        tabIndex={-1}
        data-clear-allowlist-dialog
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-warning" />
            {t('settings:allowlist.title')}
          </DialogTitle>
          <DialogDescription>
            {t('settings:allowlist.body', { count: modelCount, provider: providerId })}
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-md bg-muted/50 border border-border/60 px-3 py-2 text-xs text-muted-foreground">
          {t('settings:allowlist.undoHint')}
        </div>

        <DialogFooter className="gap-2 sm:gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            title={t('settings:allowlist.keepTitle')}
            data-action="cancel"
          >
            {t('common:action.cancel')}{' '}
            <kbd className="ml-1 text-[10px] border rounded px-1 bg-background">Esc</kbd>
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onConfirm}
            title={t('settings:allowlist.clearTitle')}
            data-action="confirm"
          >
            {t('settings:allowlist.clear')}{' '}
            <kbd className="ml-1 text-[10px] border rounded px-1 bg-background/80">↵</kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
