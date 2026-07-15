import { useCallback, useEffect, useRef, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { useUIStore } from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import { cn } from '@/lib/utils';
import { useWebSocket } from '@/hooks/useWebSocket';
import { Button } from './ui/button';
import { AlertTriangle, Check, Edit3, Globe, Loader2, RotateCw, Sparkles, X, Zap } from 'lucide-react';

export type RefineDecision = 'refined' | 'english' | 'original' | 'edit';

interface RefinePanelProps {
  original: string;
  refined: string;
  english: string;
  onDecision: (decision: RefineDecision) => void;
  /** Auto-send countdown in ms. Default 0 (no auto-send). */
  autoSendDelayMs?: number;
  /**
   * Lifecycle of the refine round-trip. 'ready' (or undefined) shows the
   * comparison; 'refining' shows an in-flight indicator; 'failed' shows the
   * recovery options.
   */
  status?: 'refining' | 'ready' | 'failed' | undefined;
  /** Failure reason shown in the recovery state. */
  error?: string | undefined;
  /** One-key "retry with another model" offer (provider/model), if any. */
  fallbackRef?: string | undefined;
  /** Retry on the same model with more time. */
  onRetry?: (() => void) | undefined;
  /** Retry on the configured fallback model ref. */
  onRetryFallback?: ((ref: string) => void) | undefined;
  /** Open the model picker to retry on a chosen provider/model. */
  onPickModel?: (() => void) | undefined;
}

/**
 * Prompt-refinement preview ("did you mean this?").
 * Shows the refined request in both original language and English,
 * plus the original. User picks one or edits.
 *
 * Keyboard shortcuts:
 * - Enter → send refined (original language)
 * - e → send English version
 * - o → send original
 * - t → edit the refined version
 * - Esc → cancel and send original
 */
export function RefinePanel({
  original,
  refined,
  english,
  onDecision,
  autoSendDelayMs = 0,
  status = 'ready',
  error,
  fallbackRef,
  onRetry,
  onRetryFallback,
  onPickModel,
}: RefinePanelProps) {
  const setRefinePanel = useUIStore((s) => s.setRefinePanel);
  const { t } = useAppTranslation();
  const enhanceLanguage = useLocalPrefs((s) => s.enhanceLanguage);
  const yolo = useLocalPrefs((s) => s.yolo);
  const { updatePrefs } = useWebSocket();

  const toggleLanguage = useCallback(() => {
    const next = enhanceLanguage === 'original' ? 'english' : 'original';
    useLocalPrefs.getState().set({ enhanceLanguage: next });
    updatePrefs({ enhanceLanguage: next });
  }, [enhanceLanguage, updatePrefs]);

  const toggleYolo = useCallback(() => {
    const next = !yolo;
    useLocalPrefs.getState().set({ yolo: next });
    updatePrefs({ yolo: next });
  }, [yolo, updatePrefs]);
  const [countdown, setCountdown] = useState(autoSendDelayMs > 0 ? Math.ceil(autoSendDelayMs / 1000) : null);
  const [editText, setEditText] = useState(refined);
  const [isEditing, setIsEditing] = useState(false);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Auto-send countdown
  useEffect(() => {
    if (autoSendDelayMs <= 0 || isEditing || status !== 'ready') return;

    countdownRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev === null || prev <= 1) {
          clearInterval(countdownRef.current!);
          onDecision('refined');
          return null;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [autoSendDelayMs, isEditing, onDecision, status]);

  // Keyboard shortcuts — only the comparison ('ready') state binds the
  // send/English/edit keys; the refining and failed states have their own
  // affordances so they must not hijack Enter/e/o/t.
  useEffect(() => {
    if (status !== 'ready') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't steal keys from inputs outside the panel
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      switch (e.key) {
        case 'Enter':
          if (!isEditing) {
            e.preventDefault();
            onDecision('refined');
          }
          break;
        case 'e':
        case 'E':
          if (!isEditing) {
            e.preventDefault();
            onDecision('english');
          }
          break;
        case 'o':
        case 'O':
          if (!isEditing) {
            e.preventDefault();
            onDecision('original');
          }
          break;
        case 't':
        case 'T':
          if (!isEditing) {
            e.preventDefault();
            setIsEditing(true);
          }
          break;
        case 'Escape':
          e.preventDefault();
          if (isEditing) {
            setIsEditing(false);
            setEditText(refined);
          } else {
            setRefinePanel(null);
            onDecision('original');
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isEditing, onDecision, refined, setRefinePanel, status]);

  // Focus the edit textarea when switching to edit mode
  useEffect(() => {
    if (isEditing && panelRef.current) {
      const textarea = panelRef.current.querySelector('textarea');
      textarea?.focus();
    }
  }, [isEditing]);

  const handleDecision = (decision: RefineDecision) => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    setRefinePanel(null);
    onDecision(decision);
  };

  const handleEditSubmit = () => {
    if (editText.trim()) {
      handleDecision('edit');
    }
  };

  // ── In-flight state ────────────────────────────────────────────────────
  // Shown while a first attempt or an extended retry is running. Keeps the
  // user's message visible (it lives only in the panel) and lets them bail out.
  if (status === 'refining') {
    return (
      <div className="rounded-lg border bg-card text-card-foreground shadow-sm overflow-hidden animate-message">
        <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span className="text-sm font-medium">{t('activity:refine.refining')}</span>
          </div>
          <button
            type="button"
            onClick={() => handleDecision('original')}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title={t('activity:refine.cancelTitle')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4">
          <div className="text-sm text-muted-foreground bg-muted/30 rounded-md px-3 py-2">
            {original.length > 200 ? original.slice(0, 200) + '…' : original}
          </div>
        </div>
        <div className="flex justify-end px-4 py-2 border-t bg-muted/20">
          <Button variant="ghost" size="sm" onClick={() => handleDecision('original')} className="text-xs">
            {t('activity:refine.sendAsIs')}
          </Button>
        </div>
      </div>
    );
  }

  // ── Failure / recovery state ───────────────────────────────────────────
  if (status === 'failed') {
    return (
      <div className="rounded-lg border border-destructive/40 bg-card text-card-foreground shadow-sm overflow-hidden animate-message">
        <div className="flex items-center justify-between px-4 py-2 border-b bg-destructive/10">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-destructive" />
            <span className="text-sm font-medium">{t('activity:refine.failedHeader')}</span>
          </div>
          <button
            type="button"
            onClick={() => handleDecision('original')}
            className="text-muted-foreground hover:text-foreground transition-colors"
            title={t('activity:refine.cancelTitle')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="p-4 space-y-3">
          {error && (
            <div className="text-xs text-destructive/90 bg-destructive/5 rounded-md px-3 py-2 break-words">
              {error}
            </div>
          )}
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground font-medium uppercase tracking-wider">
              {t('activity:refine.original')}
            </div>
            <div className="text-sm text-muted-foreground bg-muted/30 rounded-md px-3 py-2">
              {original.length > 200 ? original.slice(0, 200) + '…' : original}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3 border-t bg-muted/20">
          <Button variant="ghost" size="sm" onClick={() => handleDecision('original')} className="text-xs">
            {t('activity:refine.sendAsIs')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => handleDecision('edit')} className="text-xs">
            <Edit3 className="h-3 w-3 mr-1" />
            {t('activity:refine.edit')}
          </Button>
          {onPickModel && (
            <Button variant="outline" size="sm" onClick={onPickModel} className="text-xs">
              <Sparkles className="h-3 w-3 mr-1" />
              {t('activity:refine.pickModel')}
            </Button>
          )}
          {fallbackRef && onRetryFallback && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => onRetryFallback(fallbackRef)}
              className="text-xs"
              title={fallbackRef}
            >
              <RotateCw className="h-3 w-3 mr-1" />
              {t('activity:refine.retryFallback', { model: fallbackRef })}
            </Button>
          )}
          {onRetry && (
            <Button size="sm" onClick={onRetry} className="text-xs">
              <RotateCw className="h-3 w-3 mr-1" />
              {t('activity:refine.retry')}
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={panelRef}
      className="rounded-lg border bg-card text-card-foreground shadow-sm overflow-hidden animate-message"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{t('activity:refine.header')}</span>
          {countdown !== null && !isEditing && (
            <span className="text-xs text-muted-foreground">
              {t('activity:refine.autoSend', { count: countdown })}
            </span>
          )}
        </div>
        <button type="button"
          onClick={() => handleDecision('original')}
          className="text-muted-foreground hover:text-foreground transition-colors"
          title={t('activity:refine.cancelTitle')}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Content */}
      <div className="p-4 space-y-3">
        {isEditing ? (
          <div className="space-y-2">
            <span className="text-xs text-muted-foreground font-medium">
              {t('activity:refine.editLabel')}
            </span>
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              className="w-full min-h-[80px] rounded-md border border-input bg-background px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder={t('activity:refine.editPlaceholder')}
            />
            <div className="flex gap-2 justify-end">
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setIsEditing(false);
                  setEditText(refined);
                }}
              >
                {t('common:action.cancel')}
              </Button>
              <Button
                size="sm"
                onClick={handleEditSubmit}
                disabled={!editText.trim()}
              >
                <Check className="h-3 w-3 mr-1" />
                {t('activity:refine.useEdit')}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {/* Original */}
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-muted-foreground font-medium uppercase tracking-wider">
                {t('activity:refine.original')}
              </div>
              <div className="text-sm text-muted-foreground bg-muted/30 rounded-md px-3 py-2">
                {original.length > 200 ? original.slice(0, 200) + '...' : original}
              </div>
            </div>

            {/* Refined (Original Language) */}
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-warning font-medium uppercase tracking-wider">
                {t('activity:refine.refined')} <span className="text-muted-foreground font-normal">{t('activity:refine.yourLanguage')}</span>
              </div>
              <button
                type="button"
                className={cn(
                  'text-sm bg-warning/10 border border-warning/20 rounded-md px-3 py-2 cursor-pointer text-left w-full',
                  'hover:bg-warning/20 transition-colors',
                )}
                onClick={() => handleDecision('refined')}
                title={t('activity:refine.refinedTitle')}
              >
                {refined.length > 300 ? refined.slice(0, 300) + '...' : refined}
              </button>
            </div>

            {/* English */}
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-info font-medium uppercase tracking-wider">
                <Globe className="h-3 w-3" />
                {t('activity:refine.english')}
              </div>
              <button
                type="button"
                className={cn(
                  'text-sm bg-info/10 border border-info/20 rounded-md px-3 py-2 cursor-pointer text-left w-full',
                  'hover:bg-info/20 transition-colors',
                )}
                onClick={() => handleDecision('english')}
                title={t('activity:refine.englishTitle')}
              >
                {english.length > 300 ? english.slice(0, 300) + '...' : english}
              </button>
            </div>
          </>
        )}
      </div>

      {/* Footer with inline quick-toggles + action buttons */}
      {!isEditing && (
        <div className="flex flex-col gap-2 px-4 py-3 border-t bg-muted/20">
          {/* Inline quick-toggles — language mode + yolo */}
          <div className="flex items-center gap-3 text-[11px] text-muted-foreground/75">
            <button
              type="button"
              onClick={toggleLanguage}
              className="inline-flex items-center gap-1 hover:text-foreground/80 transition-colors"
              title={t('activity:refine.languageTitle')}
            >
              <Globe className="h-3 w-3" />
              <span>{enhanceLanguage === 'original' ? t('activity:refine.langOriginal') : t('activity:refine.langEnglish')}</span>
            </button>
            <span className="opacity-30">|</span>
            <button
              type="button"
              role="switch"
              aria-checked={yolo}
              onClick={toggleYolo}
              className="inline-flex items-center gap-1 hover:text-foreground/80 transition-colors"
              title={t('activity:refine.yoloTitle')}
            >
              <Zap className={cn('h-3 w-3', yolo && 'text-warning')} />
              <span>{t('activity:refine.yolo')}</span>
              <span
                className={cn(
                  'relative inline-block h-3 w-5 rounded-full border transition-colors',
                  yolo ? 'bg-primary border-primary/60' : 'bg-muted/70 border-border/60',
                )}
              >
                <span
                  className={cn(
                    'absolute top-[0.5px] left-[0.5px] h-2 w-2 rounded-full bg-background shadow transition-transform',
                    yolo && 'translate-x-2.5',
                  )}
                />
              </span>
            </button>
          </div>
          {/* Keyboard hints + action buttons */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex gap-1 text-xs text-muted-foreground">
              <kbd className="px-1.5 py-0.5 rounded bg-muted border font-mono">Enter</kbd>
              <span>{t('activity:refine.hintRefined')}</span>
              <kbd className="px-1.5 py-0.5 rounded bg-muted border font-mono ml-2">e</kbd>
              <span>{t('activity:refine.hintEnglish')}</span>
              <kbd className="px-1.5 py-0.5 rounded bg-muted border font-mono ml-2">o</kbd>
              <span>{t('activity:refine.hintOriginal')}</span>
              <kbd className="px-1.5 py-0.5 rounded bg-muted border font-mono ml-2">t</kbd>
              <span>{t('activity:refine.hintEdit')}</span>
            </div>
            <div className="flex gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleDecision('original')}
                className="text-xs"
              >
                <X className="h-3 w-3 mr-1" />
                {t('activity:refine.original')}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setIsEditing(true)}
                className="text-xs"
              >
                <Edit3 className="h-3 w-3 mr-1" />
                {t('activity:refine.edit')}
              </Button>
              <Button
                size="sm"
                onClick={() => handleDecision('refined')}
                className="text-xs bg-warning hover:bg-warning/90 text-primary-foreground"
              >
                <Check className="h-3 w-3 mr-1" />
                {t('activity:refine.useRefined')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
