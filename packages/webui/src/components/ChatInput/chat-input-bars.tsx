import { BookOpen, Cpu } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { useFileReferenceStore } from '@/stores';
import { FileReferenceChip } from '../FileReferenceChip.js';
import type { ImageAttachment } from './image-attachments.js';
import { SessionEffortSelect } from './session-effort-select.js';
import type { PasteHintState } from './use-paste-drop.js';

export function PasteHintBar({
  pasteHint,
  onDismiss,
  t,
}: {
  pasteHint: PasteHintState;
  onDismiss: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  return (
    <div
      className={cn(
        'rounded-md border px-2.5 py-1.5 text-xs flex items-center justify-between gap-2 animate-message',
        pasteHint.lang
          ? 'border-success/30 bg-success/5 text-success'
          : 'border-warning/30 bg-warning/5 text-warning',
      )}
    >
      <span>
        {pasteHint.lang ? (
          <>
            {t('chat:input.autoFencedAs')}{' '}
            <span className="font-mono font-semibold">{pasteHint.lang}</span>
            {' — '}
            <span className="font-mono tabular-nums">{pasteHint.chars.toLocaleString()}</span>{' '}
            {t('chat:input.charsWord')}
            {' ('}
            <span className="font-mono tabular-nums">{pasteHint.lines}</span>{' '}
            {t('chat:input.linesWord')})
          </>
        ) : (
          <>
            {t('chat:input.pastedWord')}{' '}
            <span className="font-mono tabular-nums">{pasteHint.chars.toLocaleString()}</span>{' '}
            {t('chat:input.charsWord')}
            {' ('}
            <span className="font-mono tabular-nums">{pasteHint.lines}</span>{' '}
            {t('chat:input.linesWord')}) {t('chat:input.fencedHintPrefix')}{' '}
            <span className="font-mono">```</span>.
          </>
        )}
      </span>
      <div className="flex items-center gap-1.5 shrink-0">
        {pasteHint.undoFence && (
          <button
            type="button"
            onClick={pasteHint.undoFence}
            className="underline underline-offset-2 hover:opacity-80"
            title={t('chat:input.removeFencesTitle')}
          >
            {t('common:action.undo')}
          </button>
        )}
        <button
          type="button"
          onClick={onDismiss}
          className="opacity-60 hover:opacity-100 shrink-0"
          title={t('chat:input.dismissTitle')}
          aria-label={t('chat:input.dismissTitle')}
        >
          ×
        </button>
      </div>
    </div>
  );
}

export function PendingImagesBar({
  pendingImages,
  onRemove,
  onClearAll,
  t,
}: {
  pendingImages: ImageAttachment[];
  onRemove: (id: string) => void;
  onClearAll: () => void;
  t: (key: string, options?: Record<string, unknown>) => string;
}) {
  if (pendingImages.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-1">
      <span className="text-[10px] uppercase text-muted-foreground shrink-0">
        {t('chat:input.imagesLabel')}
      </span>
      {pendingImages.map((img) => (
        <div
          key={img.id}
          className="inline-flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-1.5 py-1"
          title={img.name ?? t('chat:input.pendingAttachmentAlt')}
        >
          <img
            src={img.dataUrl}
            alt={img.name ?? t('chat:input.pendingAttachmentAlt')}
            className="h-10 w-10 rounded object-cover border border-border/50"
          />
          <span className="flex flex-col leading-tight">
            <span className="text-[11px] text-foreground/90 max-w-[120px] truncate">
              {img.name ?? t('chat:input.imageAttached')}
            </span>
            <span className="text-[10px] text-muted-foreground tabular-nums">
              {img.width && img.height ? `${img.width}×${img.height} · ` : ''}
              {Math.max(1, Math.round(img.bytes / 1024))} KB
            </span>
          </span>
          <button
            type="button"
            onClick={() => onRemove(img.id)}
            title={t('chat:input.removeImageTitle')}
            aria-label={t('chat:input.removeImageTitle')}
            className="inline-flex items-center justify-center h-5 w-5 rounded text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
          >
            ×
          </button>
        </div>
      ))}
      {pendingImages.length > 1 && (
        <button
          type="button"
          onClick={onClearAll}
          className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2 shrink-0"
        >
          {t('chat:input.clearAll')}
        </button>
      )}
    </div>
  );
}

export function FileReferencesBar({
  fileRefs,
  onRemove,
  onClearAll,
  t,
}: {
  fileRefs: ReturnType<typeof useFileReferenceStore.getState>['refs'];
  onRemove: (id: string) => void;
  onClearAll: () => void;
  t: (key: string) => string;
}) {
  if (fileRefs.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 px-1">
      <span className="text-[10px] uppercase text-muted-foreground shrink-0">
        {t('chat:input.referencesLabel')}
      </span>
      {fileRefs.map((ref) => (
        <FileReferenceChip key={ref.id} reference={ref} onRemove={() => onRemove(ref.id)} />
      ))}
      <button
        type="button"
        onClick={onClearAll}
        className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2 shrink-0"
      >
        {t('chat:input.clearAll')}
      </button>
    </div>
  );
}

export function ModelAndPromptBar({
  sessionProvider,
  sessionModel,
  fallbackProvider,
  fallbackModel,
  onOpenPromptLibrary,
  onOpenModelSwitcher,
  t,
}: {
  sessionProvider?: string | undefined;
  sessionModel?: string | undefined;
  fallbackProvider?: string | undefined;
  fallbackModel?: string | undefined;
  onOpenPromptLibrary: () => void;
  onOpenModelSwitcher: () => void;
  t: (key: string) => string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 px-1">
      <button
        type="button"
        onClick={onOpenPromptLibrary}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-card/50 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-primary/30 hover:bg-accent/50 transition-all duration-200"
        title={t('chat:input.openPromptLibrary')}
      >
        <BookOpen className="h-3.5 w-3.5" />
        {t('activity:chatInput.promptLibrary')}
      </button>
      <button
        type="button"
        onClick={onOpenModelSwitcher}
        className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-card/50 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-primary/30 hover:bg-accent/50 transition-all duration-200"
        title={t('chat:header.changeModelTitle')}
      >
        <Cpu className="h-3.5 w-3.5" />
        <span className="font-mono whitespace-nowrap">
          {(sessionProvider ?? fallbackProvider) || t('chat:header.noProvider')}
          {' / '}
          {(sessionModel ?? fallbackModel) || t('chat:header.noModel')}
        </span>
      </button>
      <SessionEffortSelect />
    </div>
  );
}
