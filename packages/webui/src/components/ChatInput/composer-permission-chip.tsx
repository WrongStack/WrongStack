import type { AcpNativeModeSelector } from '@wrongstack/contracts/types/acp-runtime';
import { acpAgentName } from '@wrongstack/contracts/types/agent-identity';
import { type AcpModeRisk, acpModeRisk } from '@wrongstack/project-surfaces/ui/acp-mode-risk';
import {
  Check,
  ChevronDown,
  LoaderCircle,
  ShieldAlert,
  ShieldCheck,
  ShieldOff,
  ShieldQuestion,
} from 'lucide-react';
import { useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { requestAcpMode } from '@/lib/acp-runtime';
import { cn } from '@/lib/utils';
import { acpModeKey, useAcpModeStore } from '@/stores/acp-mode-store';
import { useLocalPrefs } from '@/stores/local-prefs';
import { ChipPanel } from './chip-panel';
import { useComposerPopover } from './use-composer-popover';

type Approvals = 'ask' | 'yolo' | 'plus';

const LEVELS: ReadonlyArray<{
  id: Approvals;
  patch: { yolo: boolean; yoloPlus: boolean };
  risk?: AcpModeRisk | undefined;
}> = [
  { id: 'ask', patch: { yolo: false, yoloPlus: false } },
  { id: 'yolo', patch: { yolo: true, yoloPlus: false }, risk: 'caution' },
  { id: 'plus', patch: { yolo: true, yoloPlus: true }, risk: 'danger' },
];

const TONE: Record<AcpModeRisk, string> = {
  danger: 'border-destructive/50 bg-destructive/10 text-destructive hover:bg-destructive/15',
  caution: 'border-warning/50 bg-warning/10 text-warning hover:bg-warning/15',
};

/** The worse of two risks: danger over caution over none. */
function worse(a: AcpModeRisk | undefined, b: AcpModeRisk | undefined): AcpModeRisk | undefined {
  return a === 'danger' || b === 'danger' ? 'danger' : (a ?? b);
}

/**
 * The agent's current mode: the first selector's name for the chip, the worst risk across every
 * selector (Codex has two). `undefined` while no mode has been read in this tab.
 */
function currentMode(agentId: string, modes: AcpNativeModeSelector[] | undefined) {
  if (!modes) return undefined;
  const selector = modes[0];
  const name = selector
    ? (selector.options.find((choice) => choice.value === selector.currentValue)?.name ??
      selector.currentValue)
    : undefined;
  const risk = modes.reduce<AcpModeRisk | undefined>(
    (worst, each) => worse(worst, acpModeRisk(agentId, each.currentValue)),
    undefined,
  );
  return { name, risk };
}

/**
 * How freely the session acts, in one chip: WrongStack's approvals (ask, YOLO, YOLO+) and, for
 * an ACP agent, the agent's own permission mode as last read in this tab. A mode that skips the
 * agent's prompts, or YOLO+, tints the chip red; the popover changes either.
 */
export function ComposerPermissionChip({
  acpAgentId,
  inline = false,
}: {
  acpAgentId?: string | undefined;
  /** Inside the phone's Run settings dialog: the panel opens under the chip. */
  inline?: boolean | undefined;
}) {
  const { t } = useAppTranslation();
  const { updatePrefs } = useWebSocket();
  const { yolo, yoloPlus, sessionId } = useLocalPrefs(
    useShallow((s) => ({ yolo: s.yolo, yoloPlus: s.yoloPlus, sessionId: s.activeSessionId })),
  );
  const modes = useAcpModeStore((s) =>
    acpAgentId ? s.byKey[acpModeKey(sessionId, acpAgentId)] : undefined,
  );
  const { open, setOpen, anchorRef, panelRef } = useComposerPopover();
  const [modeBusy, setModeBusy] = useState(false);
  const [modeError, setModeError] = useState('');
  const approvals: Approvals = yoloPlus ? 'plus' : yolo ? 'yolo' : 'ask';
  const level = LEVELS.find((entry) => entry.id === approvals) ?? LEVELS[0]!;
  const mode = acpAgentId ? currentMode(acpAgentId, modes) : undefined;
  const risk = worse(level.risk, mode?.risk);
  // An ACP agent whose mode has not been read in this tab may be skipping its own prompts:
  // never show that as safe.
  const unknown = acpAgentId !== undefined && mode === undefined;
  const Icon =
    risk === 'danger'
      ? ShieldOff
      : risk === 'caution'
        ? ShieldAlert
        : unknown
          ? ShieldQuestion
          : ShieldCheck;
  const levelName = (id: Approvals) =>
    id === 'plus'
      ? t('chat:composerChips.approvalsPlus', { defaultValue: 'YOLO+' })
      : id === 'yolo'
        ? t('chat:composerChips.approvalsYolo', { defaultValue: 'YOLO' })
        : t('chat:composerChips.approvalsAsk', { defaultValue: 'Ask' });
  const levelHint = (id: Approvals) =>
    id === 'plus'
      ? t('chat:composerChips.approvalsPlusHint', {
          defaultValue: 'Nothing asks. Deny rules still refuse.',
        })
      : id === 'yolo'
        ? t('chat:composerChips.approvalsYoloHint', {
            defaultValue: 'Runs without asking; damaging kinds still ask.',
          })
        : t('chat:composerChips.approvalsAskHint', {
            defaultValue: 'Risky calls wait for your approval.',
          });

  const readModes = async (choice?: { optionId: string; value: string }) => {
    if (!acpAgentId || !sessionId) return;
    setModeBusy(true);
    setModeError('');
    try {
      await requestAcpMode(acpAgentId, sessionId, choice);
    } catch (error) {
      setModeError(error instanceof Error ? error.message : String(error));
    } finally {
      setModeBusy(false);
    }
  };

  return (
    <span
      ref={anchorRef}
      className={cn(inline ? 'flex min-w-0 flex-col items-start' : 'inline-flex shrink-0')}
    >
      <button
        type="button"
        data-testid="composer-permission-chip"
        data-risk={risk ?? (unknown ? 'unknown' : 'none')}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('chat:composerChips.permissions', { defaultValue: 'Permissions' })}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void readModes();
        }}
        className={cn(
          'inline-flex min-w-0 max-w-[16rem] items-center gap-1.5 border px-2 py-1.5 text-xs transition-colors',
          risk
            ? TONE[risk]
            : 'border-border/50 bg-card/50 text-muted-foreground hover:border-primary/30 hover:bg-accent/50 hover:text-foreground',
        )}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="shrink-0 font-medium">{levelName(approvals)}</span>
        {mode?.name && <span className="min-w-0 truncate opacity-90">· {mode.name}</span>}
        {unknown && (
          <span className="min-w-0 truncate opacity-90">
            · {t('chat:composerChips.agentModeUnread', { defaultValue: 'agent mode not read' })}
          </span>
        )}
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
      </button>
      {open && (
        <ChipPanel
          inline={inline}
          anchorRef={anchorRef}
          panelRef={panelRef}
          width={320}
          role="dialog"
          aria-label={t('chat:composerChips.permissions', { defaultValue: 'Permissions' })}
          data-testid="composer-permission-popover"
          className="grid gap-3 p-2"
        >
          <section className="grid gap-0.5">
            <h3 className="px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t('chat:composerChips.approvals', { defaultValue: 'WrongStack approvals' })}
            </h3>
            {LEVELS.map((entry) => {
              const active = entry.id === approvals;
              return (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    if (active) return;
                    useLocalPrefs.getState().set(entry.patch);
                    updatePrefs(entry.patch);
                  }}
                  className={cn(
                    'flex items-start gap-2 px-1.5 py-1.5 text-left hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none',
                    active && 'bg-accent/40',
                  )}
                >
                  <span
                    className={cn(
                      'mt-0.5 h-2 w-2 shrink-0 rounded-full',
                      entry.risk === 'danger'
                        ? 'bg-destructive'
                        : entry.risk === 'caution'
                          ? 'bg-warning'
                          : 'bg-success',
                    )}
                    aria-hidden="true"
                  />
                  <span className="grid min-w-0 flex-1 gap-0.5">
                    <span className="text-xs font-medium">{levelName(entry.id)}</span>
                    <span className="text-[11px] text-muted-foreground">{levelHint(entry.id)}</span>
                  </span>
                  {active && (
                    <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </section>
          {acpAgentId && (
            <section className="grid gap-0.5" aria-busy={modeBusy}>
              <h3 className="flex items-center gap-1.5 px-1.5 pb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {t('chat:composerChips.agentMode', {
                  defaultValue: '{{agent}} mode',
                  agent: acpAgentName(acpAgentId),
                })}
                {modeBusy && <LoaderCircle className="h-3 w-3 animate-spin" aria-hidden="true" />}
              </h3>
              {modes?.length === 0 && !modeBusy && (
                <p className="px-1.5 text-[11px] text-muted-foreground">
                  {t('chat:composerChips.agentModeNone', {
                    defaultValue: 'This agent reports no modes.',
                  })}
                </p>
              )}
              {modes?.map((selector) => {
                const selectable = new Set(selector.selectableValues);
                return selector.options.map((choice) => {
                  const active = choice.value === selector.currentValue;
                  const choiceRisk = acpModeRisk(acpAgentId, choice.value);
                  return (
                    <button
                      key={`${selector.id}:${choice.value}`}
                      type="button"
                      aria-pressed={active}
                      disabled={modeBusy || !selectable.has(choice.value)}
                      title={
                        selectable.has(choice.value)
                          ? undefined
                          : t('chat:composerChips.agentModeManaged', {
                              defaultValue: 'WrongStack cannot switch to this mode.',
                            })
                      }
                      onClick={() => {
                        if (!active) void readModes({ optionId: selector.id, value: choice.value });
                      }}
                      className={cn(
                        'flex items-center gap-2 px-1.5 py-1.5 text-left text-xs hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
                        active && 'bg-accent/40',
                      )}
                    >
                      <span className="min-w-0 flex-1 break-words font-medium">{choice.name}</span>
                      {choiceRisk === 'danger' && (
                        <span className="shrink-0 border border-destructive/50 bg-destructive/10 px-1 text-[10px] text-destructive">
                          {t('chat:composerChips.skipsPrompts', { defaultValue: 'Skips prompts' })}
                        </span>
                      )}
                      {choiceRisk === 'caution' && (
                        <span className="shrink-0 border border-warning/50 bg-warning/10 px-1 text-[10px] text-warning">
                          {t('chat:composerChips.fewerPrompts', { defaultValue: 'Fewer prompts' })}
                        </span>
                      )}
                      {active && (
                        <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                      )}
                    </button>
                  );
                });
              })}
              {modeError && (
                <p role="alert" className="px-1.5 text-[11px] text-destructive">
                  {modeError}
                </p>
              )}
            </section>
          )}
        </ChipPanel>
      )}
    </span>
  );
}
