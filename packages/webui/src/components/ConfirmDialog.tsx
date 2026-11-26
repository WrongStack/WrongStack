import { AlertTriangle, FileEdit, Globe, ShieldAlert, Terminal, Wrench, Zap } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { useUIStore } from '@/stores';
import { useLocalPrefs } from '@/stores/local-prefs';
import { diffFromToolInput, ToolDiffView } from './DiffView';
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
 * YOLO stopped because a rule the user wrote forbids this call. "Always" has
 * nothing to remember here — the rule is checked first, so the server runs an
 * "always" answer once, like "yes" — and the dialog does not offer it.
 */
export function isUserRuleConfirm(info: { decisionSource?: string | undefined }): boolean {
  return info.decisionSource === 'yolo_user_rule';
}

export function isDestructiveConfirm(info: {
  decisionSource?: string | undefined;
  riskTier?: 'safe' | 'standard' | 'destructive' | undefined;
}): boolean {
  return info.riskTier === 'destructive' || info.decisionSource === 'yolo_destructive';
}

/**
 * Bidi and zero-width controls, dropped from everything the approval shows: in
 * an approval they only make the displayed text diverge from the real one (a
 * U+202E reorders the command). Same character set as core's
 * sanitizeTerminalText, which the TUI dialog uses.
 */
const HIDDEN_TEXT_RE = /[\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/gu;

function withoutHiddenText(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(HIDDEN_TEXT_RE, '');
  if (Array.isArray(value)) return value.map(withoutHiddenText);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k.replace(HIDDEN_TEXT_RE, ''), withoutHiddenText(v)]),
    );
  }
  return value;
}

/**
 * Render the tool input intelligently. For edit/write we drop the JSON
 * dump and show a proper diff. For shell-like tools we surface the
 * command as a single mono line. Everything else falls back to JSON.
 */
function SmartInputPreview({ toolName, input: raw }: { toolName: string; input: unknown }) {
  const { t } = useAppTranslation();
  const input = withoutHiddenText(raw);
  const diff = diffFromToolInput(toolName, input);
  if (diff) {
    return (
      <div className="max-h-[min(45dvh,24rem)] overflow-auto rounded-lg border">
        <ToolDiffView diff={diff} />
      </div>
    );
  }

  // Shell-like: pull out the command string so it shows as a real terminal
  // line instead of a JSON envelope.
  if (typeof input === 'object' && input !== null) {
    const obj = input as Record<string, unknown>;
    const cmd = (obj.command ?? obj.cmd ?? obj.script) as string | undefined;
    if (typeof cmd === 'string' && cmd.trim().length > 0) {
      // Everything the command line does NOT already show. This block used to
      // be missing and the branch returned early, so `exec`'s separate `args`
      // array was invisible: `exec({command:"node", args:["-e","<payload>"]})`
      // rendered as just `node`. Same for `git`, whose parameters are named
      // fields rather than an argv array. The permission SUBJECT was computed
      // correctly from the full invocation — only this preview was lossy — but
      // an approval prompt that hides what it is approving is the one thing it
      // must never do.
      const consumed = new Set(['command', 'cmd', 'script']);
      const rest = Object.entries(obj).filter(
        ([k, v]) => !consumed.has(k) && v !== undefined && v !== null && v !== '',
      );
      return (
        <div className="rounded-lg border bg-background/40 overflow-hidden">
          <div className="px-3 py-1.5 text-[10px] uppercase tracking-wider text-muted-foreground border-b bg-muted/40 flex items-center gap-1.5">
            <Terminal className="h-3 w-3" />
            <span>{t('confirm.command')}</span>
          </div>
          <pre className="max-h-[min(24dvh,12rem)] overflow-auto whitespace-pre-wrap break-all px-3 py-2 font-mono text-xs">
            {cmd}
          </pre>
          {rest.length > 0 && (
            <pre
              className="max-h-[min(30dvh,14rem)] overflow-auto whitespace-pre-wrap break-all border-t bg-muted/20 px-3 py-2 font-mono text-xs"
              data-testid="confirm-args-preview"
            >
              {rest
                .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
                .join('\n')}
            </pre>
          )}
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
    <div className="rounded-lg border bg-muted/50 p-3 font-mono text-xs">
      <div className="text-muted-foreground mb-2">{t('confirm.inputLabel')}</div>
      <pre className="max-h-[min(40dvh,20rem)] overflow-auto whitespace-pre-wrap break-all">
        {JSON.stringify(input, null, 2)}
      </pre>
    </div>
  );
}

export function ConfirmDialog() {
  const { showConfirmDialog, confirmInfo, hideConfirm } = useUIStore(
    useShallow((s) => ({
      showConfirmDialog: s.showConfirmDialog,
      confirmInfo: s.confirmInfo,
      hideConfirm: s.hideConfirm,
    })),
  );
  const { t } = useAppTranslation();
  const yolo = useLocalPrefs((s) => s.yolo);
  const setLocalPrefs = useLocalPrefs((s) => s.set);
  const { sendConfirm, updatePrefs } = useWebSocket();
  const dialogRef = useRef<HTMLDivElement>(null);
  const resolvedRef = useRef(false);
  const [approvalScope, setApprovalScope] = useState<
    'always-exact' | 'always-command' | 'always-tool'
  >('always-exact');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (showConfirmDialog && confirmInfo) {
      resolvedRef.current = false;
      setApprovalScope('always-exact');
    }
  }, [showConfirmDialog, confirmInfo?.id, confirmInfo]);

  useEffect(() => {
    if (!showConfirmDialog || !confirmInfo?.deadlineAt) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [showConfirmDialog, confirmInfo?.id, confirmInfo?.deadlineAt]);

  const handleConfirm = (
    decision: 'yes' | 'no' | 'always' | 'always-exact' | 'always-command' | 'always-tool' | 'deny',
  ) => {
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
  // auto-approves the current confirm; the broadcast prefs.updated then hides
  // this dialog. The auto-yolo effect below is the client-side backstop.
  const enableYolo = () => {
    if (confirmInfo?.boundaryReason) return;
    setLocalPrefs({ yolo: true });
    updatePrefs({ yolo: true });
  };

  useEffect(() => {
    if (
      !showConfirmDialog ||
      !confirmInfo ||
      !yolo ||
      confirmInfo.boundaryReason ||
      isDestructiveConfirm(confirmInfo)
    )
      return;
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
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      // Bare letters only, as the TUI prompt drops ctrl/meta chords:
      // Ctrl/Cmd+A (select-all) must not approve with the "always" scope.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault();
        handleConfirm('yes');
      } else if (e.key === 'n' || e.key === 'N' || e.key === 'Escape') {
        e.preventDefault();
        handleConfirm('no');
      } else if (
        (e.key === 'a' || e.key === 'A') &&
        !(confirmInfo && isUserRuleConfirm(confirmInfo))
      ) {
        e.preventDefault();
        handleConfirm(approvalScope);
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
  }, [showConfirmDialog, confirmInfo?.id, approvalScope]);

  if (!confirmInfo) {
    return null;
  }

  const Icon = pickToolIcon(confirmInfo.toolName);
  // MCP tool names come from the server that registered them.
  const shownToolName = confirmInfo.toolName.replace(HIDDEN_TEXT_RE, '');
  const isEdit = /edit|write/i.test(confirmInfo.toolName);
  const riskLabel = confirmInfo.riskTier ?? 'standard';
  const remainingSeconds = confirmInfo.deadlineAt
    ? Math.max(0, Math.ceil((confirmInfo.deadlineAt - now) / 1_000))
    : undefined;
  const remainingLabel =
    remainingSeconds === undefined
      ? undefined
      : `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, '0')}`;

  return (
    <Dialog open={showConfirmDialog} onOpenChange={handleOpenChange}>
      <DialogContent
        className="!flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] flex-col gap-0 overflow-hidden border-warning/50 !p-0 sm:max-w-2xl"
        ref={dialogRef}
        tabIndex={-1}
      >
        <DialogHeader className="shrink-0 border-b border-border/60 px-3 py-3 pr-10 sm:px-6 sm:py-5 sm:pr-12">
          <DialogTitle className="flex items-center gap-2">
            <ShieldAlert className="h-5 w-5 text-warning animate-pulse" />
            {t('confirm.title', { tool: shownToolName })}
          </DialogTitle>
          <DialogDescription>
            {confirmInfo.boundaryReason?.replace(HIDDEN_TEXT_RE, '') ??
              (isEdit ? t('confirm.descriptionEdit') : t('confirm.descriptionTool'))}
          </DialogDescription>
          {isUserRuleConfirm(confirmInfo) ? (
            <p className="text-left text-xs text-warning">{t('confirm.yoloUserRuleNote')}</p>
          ) : (
            yolo &&
            isDestructiveConfirm(confirmInfo) && (
              <p className="text-left text-xs text-warning">{t('confirm.yoloDestructiveNote')}</p>
            )
          )}
          {remainingLabel && (
            <p className="text-left text-xs text-muted-foreground" aria-live="polite">
              {remainingSeconds === 0
                ? t('confirm.brainDeciding')
                : t('confirm.brainCountdown', { time: remainingLabel })}
            </p>
          )}
        </DialogHeader>

        <div
          className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-3 py-2 sm:px-6 sm:py-3"
          data-testid="confirm-scroll-region"
        >
          <div className="flex items-center gap-3 p-3 rounded-lg bg-muted">
            <Icon className="h-5 w-5 text-muted-foreground" />
            <div className="min-w-0">
              <div className="font-medium font-mono truncate">{shownToolName}</div>
              <div className="text-xs text-muted-foreground">
                {isEdit ? t('confirm.fileModification') : t('confirm.toolExecution')} —{' '}
                {t('confirm.riskSuffix', { risk: riskLabel })}
              </div>
            </div>
          </div>

          {confirmInfo.writeTargets && confirmInfo.writeTargets.length > 0 && (
            <div
              className="rounded-lg border border-warning/40 p-3 text-xs"
              data-testid="confirm-write-targets"
            >
              <div className="mb-1 font-medium text-warning">{t('confirm.writes')}</div>
              <ul className="space-y-0.5 break-all font-mono">
                {confirmInfo.writeTargets.map((target, i) => (
                  <li key={`${i}:${target}`}>{target.replace(HIDDEN_TEXT_RE, '')}</li>
                ))}
              </ul>
            </div>
          )}

          {confirmInfo.input !== undefined && (
            <SmartInputPreview toolName={confirmInfo.toolName} input={confirmInfo.input} />
          )}

          {!isUserRuleConfirm(confirmInfo) && (
            <label className="block space-y-1 text-sm">
              <span>{t('confirm.approvalScope')}</span>
              <select
                aria-label={t('confirm.approvalScope')}
                className="w-full min-w-0 rounded border bg-background p-2"
                value={approvalScope}
                onChange={(event) => setApprovalScope(event.target.value as typeof approvalScope)}
              >
                <option value="always-exact">{t('confirm.scopeExact')}</option>
                {confirmInfo.toolName === 'exec' && (
                  <option value="always-command">{t('confirm.scopeCommand')}</option>
                )}
                <option value="always-tool">
                  {t('confirm.scopeTool', { tool: shownToolName })}
                </option>
              </select>
              <span className="block text-xs text-muted-foreground">{t('confirm.scopeHint')}</span>
            </label>
          )}

          {confirmInfo.suggestedPattern && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-warning/10 border border-warning/20">
              <AlertTriangle className="h-4 w-4 text-warning mt-0.5 shrink-0" />
              <div className="text-sm min-w-0">
                <div className="font-medium text-warning">{t('confirm.trustSuggestionTitle')}</div>
                <div className="font-mono text-xs mt-1 break-all">
                  {confirmInfo.suggestedPattern.replace(HIDDEN_TEXT_RE, '')}
                </div>
                <div className="text-xs text-muted-foreground mt-1">
                  {t('confirm.trustSuggestionHint')}
                </div>
              </div>
            </div>
          )}

          {!yolo && !confirmInfo.boundaryReason && !isDestructiveConfirm(confirmInfo) && (
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

        <DialogFooter className="!grid shrink-0 grid-cols-2 gap-1 border-t border-border/60 bg-card px-3 py-2 sm:!flex sm:flex-wrap sm:gap-2 sm:px-6 sm:py-4">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleConfirm('deny')}
            title={t('confirm.denyAlwaysTitle')}
          >
            {t('confirm.denyAlways')}{' '}
            <kbd className="ml-1 text-[10px] border rounded px-1 bg-background">d</kbd>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleConfirm('no')}
            title={t('confirm.noTitle')}
          >
            {t('action.no')}{' '}
            <kbd className="ml-1 text-[10px] border rounded px-1 bg-background">n</kbd>
          </Button>
          {!isUserRuleConfirm(confirmInfo) && (
            <Button
              variant="outline"
              size="sm"
              data-testid="confirm-remember"
              onClick={() => handleConfirm(approvalScope)}
              title={t('confirm.alwaysTitle')}
            >
              {t('action.always')}{' '}
              <kbd className="ml-1 text-[10px] border rounded px-1 bg-background">a</kbd>
            </Button>
          )}
          <Button size="sm" onClick={() => handleConfirm('yes')} title={t('confirm.yesTitle')}>
            {t('action.yes')}{' '}
            <kbd className="ml-1 text-[10px] border rounded px-1 bg-background/80">y</kbd>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
