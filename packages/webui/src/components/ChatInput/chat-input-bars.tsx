import { BookOpen, ChevronDown, Cpu, FileText, History, SlidersHorizontal } from 'lucide-react';
import { useIsFullChrome } from '@/hooks/useChromeLevel';
import { cn } from '@/lib/utils';
import { openMainView } from '@/lib/view-navigation';
import type { useFileReferenceStore } from '@/stores';
import { FileReferenceChip } from '../FileReferenceChip.js';
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from '../ui/dialog.js';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu.js';
import { CompanionsButton } from './companions-button.js';
import { type ImageAttachment, isPdfAttachment } from './image-attachments.js';
import { SessionEffortSelect } from './session-effort-select.js';
import { SubagentModelsButton } from './subagent-models-button.js';
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
          {isPdfAttachment(img) ? (
            <span className="flex h-10 w-10 items-center justify-center rounded border border-border/50 bg-background/40">
              <FileText className="h-5 w-5 text-muted-foreground" />
            </span>
          ) : (
            <img
              src={img.dataUrl}
              alt={img.name ?? t('chat:input.pendingAttachmentAlt')}
              className="h-10 w-10 rounded object-cover border border-border/50"
            />
          )}
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
  const fullChrome = useIsFullChrome();
  return (
    <div className="ws-composer-options flex min-w-0 flex-wrap items-center gap-1.5">
      {fullChrome ? (
        <>
          <button
            type="button"
            onClick={() => openMainView('prompts')}
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/60 text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={t('activity:promptJournal.title')}
            aria-label={t('activity:promptJournal.title')}
          >
            <History className="h-3.5 w-3.5" aria-hidden />
          </button>
          <button
            type="button"
            onClick={onOpenPromptLibrary}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-card/50 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-primary/30 hover:bg-accent/50 transition-all duration-200"
            title={t('chat:input.openPromptLibrary')}
          >
            <BookOpen className="h-3.5 w-3.5" />
            {t('activity:chatInput.promptLibrary')}
          </button>
        </>
      ) : (
        // Calm chrome: the prompt library and the prompt journal share one
        // "Prompts" menu instead of two loose buttons.
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="composer-prompts-menu"
              className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-card/50 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-primary/30 hover:bg-accent/50 transition-all duration-200"
            >
              <BookOpen className="h-3.5 w-3.5" />
              {t('chat:input.promptsMenu')}
              <ChevronDown className="h-3 w-3 opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuItem onSelect={onOpenPromptLibrary} className="gap-2">
              <BookOpen className="h-4 w-4" />
              {t('activity:chatInput.promptLibrary')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => openMainView('prompts')} className="gap-2">
              <History className="h-4 w-4" />
              {t('activity:promptJournal.title')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <button
        type="button"
        onClick={onOpenModelSwitcher}
        className="inline-flex min-w-0 max-w-full items-center gap-1.5 border border-border/50 bg-card/50 px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground hover:border-primary/30 hover:bg-accent/50 transition-colors duration-150"
        title={t('chat:header.changeModelTitle')}
      >
        <Cpu className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate font-mono">
          {(sessionProvider ?? fallbackProvider) || t('chat:header.noProvider')}
          {' / '}
          {(sessionModel ?? fallbackModel) || t('chat:header.noModel')}
        </span>
      </button>
      <div className="hidden md:contents">
        <SessionEffortSelect />
        <SubagentModelsButton />
        <CompanionsButton />
      </div>
      <Dialog>
        <DialogTrigger asChild>
          <button
            type="button"
            aria-label={t('chat:input.runSettings')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-card/50 px-2.5 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:bg-accent/50 hover:text-foreground md:hidden"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            {t('chat:input.runSettings')}
            <ChevronDown className="h-3 w-3 opacity-60" />
          </button>
        </DialogTrigger>
        <DialogContent
          aria-describedby={undefined}
          className="w-[min(24rem,calc(100vw-2rem))] p-4 md:hidden"
        >
          <DialogTitle className="text-base">{t('chat:input.runSettings')}</DialogTitle>
          <div className="ws-mobile-run-settings grid gap-3">
            <SessionEffortSelect />
            <SubagentModelsButton />
            <CompanionsButton />
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
