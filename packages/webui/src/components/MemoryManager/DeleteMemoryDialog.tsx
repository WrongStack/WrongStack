import { Loader2, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { SageEntry } from '@/types';
import { memoryPreview } from './shared';

interface DeleteMemoryDialogProps {
  busyAction: 'create' | 'update' | 'delete' | null;
  deletingId: string | null;
  memories: readonly SageEntry[];
  onCancel: () => void;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
}

export function DeleteMemoryDialog({
  busyAction,
  deletingId,
  memories,
  onCancel,
  onConfirm,
  onOpenChange,
}: DeleteMemoryDialogProps) {
  return (
    <Dialog open={Boolean(deletingId)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <span className="mb-2 flex size-10 items-center justify-center border border-destructive/35 bg-destructive/10 text-destructive">
            <Trash2 className="size-4" />
          </span>
          <DialogTitle>Delete this memory?</DialogTitle>
          <DialogDescription className="leading-6">
            SAGE will mark the record deleted, remove graph edges, and clean references from related
            memories. The record remains in the audit trail but cannot be restored from this page.
          </DialogDescription>
        </DialogHeader>
        <div className="border border-border/70 bg-background/45 p-3 text-xs text-muted-foreground">
          {memoryPreview(memories.find((memory) => memory.id === deletingId)?.text ?? '', 180)}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={busyAction === 'delete'}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busyAction === 'delete'}>
            {busyAction === 'delete' ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Trash2 className="size-4" />
            )}
            {busyAction === 'delete' ? 'Deleting…' : 'Delete memory'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
