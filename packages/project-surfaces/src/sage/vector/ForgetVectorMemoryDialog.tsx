/**
 * ForgetVectorMemoryDialog — destructive confirmation for removing a single
 * vector-memory search hit from the store. Pattern-matched on the
 * MemoryManager's DeleteMemoryDialog (destructive icon, text preview,
 * cancel/destructive footer, busy spinner); kept local to the panel so the
 * feature stays self-contained.
 */
import { Loader2, Trash2 } from 'lucide-react';
import { useAppTranslation } from '../../lib/i18n';

import { Button } from '../../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../ui/dialog';

import { previewText, type VectorMemoryHit } from './model.js';

interface ForgetVectorMemoryDialogProps {
  /** The hit pending removal. The dialog is open while this is non-null. */
  hit: VectorMemoryHit | null;
  busy: boolean;
  error: string | undefined;
  onCancel: () => void;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}

export function ForgetVectorMemoryDialog({
  hit,
  busy,
  error,
  onCancel,
  onConfirm,
  onOpenChange,
}: ForgetVectorMemoryDialogProps) {
  const { t } = useAppTranslation();
  return (
    <Dialog open={hit !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <span className="mb-2 flex size-10 items-center justify-center border border-destructive/35 bg-destructive/10 text-destructive">
            <Trash2 className="size-4" />
          </span>
          <DialogTitle>{t('activity:sageText.forgetTitle')}</DialogTitle>
          <DialogDescription className="leading-6">
            {t('activity:sageText.forgetBody')}
          </DialogDescription>
        </DialogHeader>
        <div className="border border-border/70 bg-background/45 p-3 text-xs text-muted-foreground">
          {previewText(hit?.text ?? '', 180)}
        </div>
        {error !== undefined ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            {t('common:action.cancel')}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            {busy ? t('activity:sageText.forgetting') : t('activity:sageText.forgetMemory')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
