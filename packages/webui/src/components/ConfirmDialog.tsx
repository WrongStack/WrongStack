import { useWebSocket } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { useLocalPrefs } from '@/stores/local-prefs';
import { useUIStore } from '@/stores';
import { AlertTriangle, FileEdit, Globe, ShieldAlert, Terminal, Wrench, Zap } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { DiffView, diffFromToolInput } from './DiffView';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog';

/**
 * Pick the right hero icon for the tool being confirmed. Helps the user
 * see at a glance "is this a file edit, a shell run, a network call?".
 */
function pickToolIcon(toolName: string) {
  if (/edit|write|create|patch/i.test(toolName)) return FileEdit;
  if (/bash|shell|exec|run|command/i.test(toolName)) return Terminal;
  if (/fetch|http|web|curl|request/i.test(toolName)) return Globe;
  return Wrench;
}

/**
 * Render the tool input intelligently. For edit/write we drop the JSON
 * dump and show a proper diff. For shell-like tools we surface the
 * command as a single mono line. Everything else falls back to JSON.
 */
function SmartInputPreview({
  toolName,
  input,
}: {
  toolName: string;
  input: unknown;
}) {
  const { t } = useAppTranslation();
  const diffArgs = diffFromToolInput(toolName, input);
  if (diffArgs) {
    return (
      <div className="rounded-lg overflow-hidden border">
        <DiffView
          oldText={diffArgs.oldText}
          newText={diffArgs.newText}
          caption={diffArgs.caption}
        />
      </div>
    );
  }

  // Shell-like: pull out the command string so it shows as a real terminal
  // line instead of a JSON envelope.
  if (typeof input === 'object' && input !== null) {
    const obj = input as Record<string, unknown>;
    const cmd = (obj.command ?? obj.cmd ?? obj.script) as string | undefined;
    if (typeof cmd === 'string' && cmd.trim().length > 0) {
      return (
        <div className="rounded-lg border bg-background/40 overflow-hidden">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground border-b bg-muted/40 flex items-center gap-1.5">
            <Terminal className="h-3 w-3" />
            <span>{t('confirm.command')}</span>
          </div>
          <pre className="px-3 py-2 text-xs font-mono whitespace-pre-wrap break-all max-h-40 overflow-auto">
            {cmd}
          </pre>
        </div>
      );
    }
    // url + method for fetch-like calls
    const url = obj.url as string | undefined;
    if (typeof url === 'string') {
      const method = (obj.method as string | undefined) ?? 'GET';
      return (
        <div className="rounded-lg border bg-background/40 px-3 py-2 text-xs font-mono">
          <span className="text-muted-foreground">{method.toUpperCase()}</span>{' '}
          <span className="break-all">{url}</span>
        </div>
      );
    }
  }

  return (
    <div className="p-3 rounded-lg bg-muted/50 border text-xs font-mono">
      <div className="text-muted-foreground mb-2">{t('confirm.inputLabel')}</div>
      <pre className="whitespace-pre-wrap break-all max-h-60 overflow-auto">
        {JSON.stringify(input, null, 2)}
      </pre>
    </div>
  );
}

export function ConfirmDialog() {
  const { showConfirmDialog, confirmInfo, hideConfirm } = useUIStore();
  const { t } = useAppTranslation();
  const yolo = useLocalPrefs((s) => s.yolo);
  const setLocalPrefs = useLocalPrefs((s) => s.set);
  const { sendConfirm, updatePrefs } = useWebSocket();
  const dialogRef = useRef<HTMLDivElement>(null);
  const resolvedRef = useRef(false);

  useEffect(() => {
    if (showConfirmDialog && confirmInfo) {
      resolvedRef.current = false;
    }
  }, [showConfirmDialog, confirmInfo?.id, confirmInfo]);

  const handleConfirm = (decision: 'yes' | 'no' | 'always' | 'deny') => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    if (confirmInfo) {
      sendConfirm(confirmInfo.id, decision);
    }
    hideConfirm();
  };

  const handleOpenChange = (open: boolean) => {
    if (open) return;
    if (confirmInfo) {
      handleConfirm('no');
      return;
    }
    hideConfirm();
  };

  // One-click "enable YOLO" straight from the approval modal. Flips the local
  // pref and pushes it to the server. The server's prefs.update handler runs
  // permissionPolicy.setYolo(true) + resolveYoloEligiblePendingConfirms(), which
  // auto-approves the CURRENT non-destructive confirm; the broadcast
  // prefs.updated then hides this dialog. The auto-yolo effect below is the
  // client-side backstop. Destructive prompts stay for an explicit decision.
  const enableYolo = () => {
    setLocalPrefs({ yolo: true });
    updatePrefs({ yolo: true });
  };

  useEffect(() => {
    if (!showConfirmDialog || !confirmInfo || !yolo) return;
    if (confirmInfo.riskTier === 'destructive') return;
    if (confirmInfo.decisionSource === 'yolo_destructive') return;
    handleConfirm('yes');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    showConfirmDialog,
    confirmInfo?.id,
    confirmInfo?.decisionSource,
    confirmInfo?.riskTier,
    yolo,
  ]);

  // Keyboard shortcuts: y/n/a/d/Esc — matches the CLI and TUI permission
  // prompts so muscle memory transfers directly across all surfaces.
  useEffect(() => {
    if (!showConfirmDialog) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault();
        handleConfirm('yes');
      } else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') {
        e.preventDefault();
        handleConfirm('no');
      } else if (e.key === 'a' || e.key === 'A') {
        e.preventDefault();
        handleConfirm('always');
      } else if (e.key === 'd' || e.key === 'D') {
        e.preventDefault();
        handleConfirm('deny');
      }
    };
    window.addEventListener('keydown', onKey);
    // Focus the dialog container so keyboard shortcuts work immediately
    // without the user having to click into the dialog first.
    dialogRef.current?.focus();
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showConfirmDialog, confirmInfo?.id]);

  if (!confirmInfo) {
    return null;
  }

  const Icon = pickToolIcon(confirmInfo.toolName);
  const isEdit = /edit|write/i.test(confirmInfo.toolName);
  const riskLabel = confirmInfo.riskTier ?? 'standard';

  return (
    <Dialog open={showConfirmDialog} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-2xl max-h-[min(88dvh,760px)] overflow-hidden !flex flex-col border-yellow-500/50"
        ref={dialogRef}
        tabIndex={-1}
      >
        <DialogHeader className="shrink-0">
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-yellow-500 animate-pulse" />
            {t('confirm.title', { tool: confirmInfo.toolName })}
          </DialogTitle>
          <DialogDescription>
            {isEdit ? t('confirm.descriptionEdit') : t('confirm.descriptionTool')}
          </DialogDescription>
        </DialogHeader>

        <div className="py-2 pr-1 space-y-3 overflow-y-auto min-h-0 flex-1">
          <div className="flex items-center gap-3 p-3 rounded-lg bg-muted">
            <Icon className="h-5 w-5 text-muted-foreground" />
            <div className="min-w-0">
              <div className="font-medium font-mono truncate">{confirmInfo.toolName}</div>
              <div className="text-xs text-muted-foreground">
                {isEdit ? t('confirm.fileModification') : t('confirm.toolExecution')} —{' '}
                {t('confirm.riskSuffix', { risk: riskLabel })}
              </div>
            </div>
          </div>

          {confirmInfo.input !== undefined && (
            <SmartInputPreview toolName={confirmInfo.toolName} input={confirmInfo.input} />
          )}

          {confirmInfo.suggestedPattern && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/20">
              <AlertTriangle className="h-4 w-4 text-yellow-600 mt-0.5 shrink-0" />
              <div className="text-sm min-w-0">
                <div className="font-medium text-yellow-800 dark:text-yellow-200">
                  {t('confirm.trustSuggestionTitle')}
                </div>
                <div className="font-mono text-xs mt-1 break-all">
                  {confirmInfo.suggestedPattern}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {t('confirm.trustSuggestionHint')}
                </div>
              </div>
            </div>
          )}

          {yolo &&
            (confirmInfo.riskTier === 'destructive' ||
              confirmInfo.decisionSource === 'yolo_destructive') && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {t('confirm.yoloDestructiveNote')}
              </div>
            )}

          {!yolo && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-primary/5 border border-primary/20">
              <Zap className="h-4 w-4 text-primary mt-0.5 shrink-0" />
              <div className="text-sm min-w-0 flex-1">
                <div className="font-medium">{t('confirm.skipApprovalsTitle')}</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  {t('confirm.skipApprovalsHint')}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={enableYolo}
                title={t('confirm.enableYoloTitle')}
                className="shrink-0"
              >
                {t('confirm.enableYoloBtn')}
              </Button>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2 flex-wrap shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleConfirm('deny')}
            title={t('confirm.denyAlwaysTitle')}
          >
            {t('confirm.denyAlways')} <kbd className="ml-1 text-[10px] border rounded px-1 bg-background">d</kbd>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleConfirm('no')}
            title={t('confirm.noTitle')}
          >
            {t('action.no')} <kbd className="ml-1 text-[10px] border rounded px-1 bg-background">n</kbd>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleConfirm('always')}
            title={t('confirm.alwaysTitle')}
          >
            {t('action.always')} <kbd className="ml-1 text-[10px] border rounded px-1 bg-background">a</kbd>
          </Button>
          <Button
            size="sm"
            onClick={() => handleConfirm('yes')}
            title={t('confirm.yesTitle')}
          >
            {t('action.yes')} <kbd className="ml-1 text-[10px] border rounded px-1 bg-background/80">y</kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
