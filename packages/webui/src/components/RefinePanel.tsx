import { useEffect, useRef, useState } from 'react';
import { useAppTranslation } from '@/i18n';
import { useUIStore } from '@/stores';
import { cn } from '@/lib/utils';
import { Button } from './ui/button';
import { Check, Edit3, Globe, X } from 'lucide-react';

export type RefineDecision = 'refined' | 'english' | 'original' | 'edit';

interface RefinePanelProps {
  original: string;
  refined: string;
  english: string;
  onDecision: (decision: RefineDecision) => void;
  /** Auto-send countdown in ms. Default 0 (no auto-send). */
  autoSendDelayMs?: number;
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
}: RefinePanelProps) {
  const setRefinePanel = useUIStore((s) => s.setRefinePanel);
  const { t } = useAppTranslation();
  const [countdown, setCountdown] = useState(autoSendDelayMs > 0 ? Math.ceil(autoSendDelayMs / 1000) : null);
  const [editText, setEditText] = useState(refined);
  const [isEditing, setIsEditing] = useState(false);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Auto-send countdown
  useEffect(() => {
    if (autoSendDelayMs <= 0 || isEditing) return;

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
  }, [autoSendDelayMs, isEditing, onDecision]);

  // Keyboard shortcuts
  useEffect(() => {
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
  }, [isEditing, onDecision, refined, setRefinePanel]);

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
        <button
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
            <label className="text-xs text-muted-foreground font-medium">
              {t('activity:refine.editLabel')}
            </label>
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
              <div
                className={cn(
                  'text-sm bg-warning/10 border border-warning/20 rounded-md px-3 py-2 cursor-pointer',
                  'hover:bg-warning/20 transition-colors',
                )}
                onClick={() => handleDecision('refined')}
                title={t('activity:refine.refinedTitle')}
              >
                {refined.length > 300 ? refined.slice(0, 300) + '...' : refined}
              </div>
            </div>

            {/* English */}
            <div className="space-y-1">
              <div className="flex items-center gap-1 text-xs text-info font-medium uppercase tracking-wider">
                <Globe className="h-3 w-3" />
                {t('activity:refine.english')}
              </div>
              <div
                className={cn(
                  'text-sm bg-info/10 border border-info/20 rounded-md px-3 py-2 cursor-pointer',
                  'hover:bg-info/20 transition-colors',
                )}
                onClick={() => handleDecision('english')}
                title={t('activity:refine.englishTitle')}
              >
                {english.length > 300 ? english.slice(0, 300) + '...' : english}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Footer with action buttons */}
      {!isEditing && (
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-t bg-muted/20">
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
      )}
    </div>
  );
}
