import { Loader2, ShieldAlert, Trash2 } from 'lucide-react';
import { useAppTranslation } from '../lib/i18n';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import type { SageEntry } from './model-types';
import { memoryPreview } from './shared';

interface DeleteMemoryDialogProps {
  busyAction: 'create' | 'update' | 'delete' | null;
  deletingId: string | null;
  /** Resolved target — may be a search hit or graph neighbor outside the loaded page. */
  memory: SageEntry | null;
  /** Whether the pending delete also marks the record `neverInject`. */
  neverInject: boolean;
  onNeverInjectChange: (next: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}

export function DeleteMemoryDialog({
  busyAction,
  deletingId,
  memory,
  neverInject,
  onNeverInjectChange,
  onCancel,
  onConfirm,
  onOpenChange,
}: DeleteMemoryDialogProps) {
  const { t } = useAppTranslation();
  const disabled = busyAction === 'delete';
  return (
    <Dialog open={Boolean(deletingId)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <span className="mb-2 flex size-10 items-center justify-center border border-destructive/35 bg-destructive/10 text-destructive">
            <Trash2 className="size-4" />
          </span>
          <DialogTitle>{t('activity:memoryManager.deleteTitle')}</DialogTitle>
          <DialogDescription className="leading-6">
            {t('activity:deleteMemoryDialog.sageWillMarkTheRecordDeleted')}
          </DialogDescription>
        </DialogHeader>
        <div className="border border-border/70 bg-background/45 p-3 text-xs text-muted-foreground">
          {memoryPreview(memory?.text ?? '', 180)}
        </div>
        {/* Opt-in, off by default. A plain delete is recoverable via
            `memory.sage.recover`; `neverInject` is a stronger, one-way claim
            that the memory is factually wrong, so it must be a deliberate
            choice rather than a default side effect of deleting. */}
        <label className="flex cursor-pointer items-start gap-2.5 border border-border/70 bg-background/35 p-3 text-xs hover:border-warning/45">
          <input
            type="checkbox"
            className="mt-0.5 size-3.5 shrink-0 accent-primary"
            checked={neverInject}
            disabled={disabled}
            onChange={(event) => onNeverInjectChange(event.target.checked)}
          />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 font-semibold text-foreground">
              <ShieldAlert className="size-3.5 text-warning" />
              {t('activity:deleteMemoryDialog.neverInjectLabel')}
            </span>
            <span className="mt-1 block leading-5 text-muted-foreground">
              {t('activity:deleteMemoryDialog.neverInjectHint')}
            </span>
          </span>
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={disabled}>
            {t('common:action.cancel')}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={disabled}>
            {busyAction === 'delete' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
            {busyAction === 'delete'
              ? t('activity:memoryManager.deletingLabel')
              : t('activity:memoryManager.actionDeleteMemory')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
