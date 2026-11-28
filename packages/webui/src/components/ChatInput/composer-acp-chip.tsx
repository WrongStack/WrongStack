import type { AcpRuntimeOption } from '@wrongstack/contracts/types/acp-runtime';
import { acpAgentName } from '@wrongstack/contracts/types/agent-identity';
import {
  isEffortOption,
  isModelOption,
  useAcpRuntime,
} from '@wrongstack/project-surfaces/ui/use-acp-runtime';
import { Brain, ChevronDown, Cpu, LoaderCircle, RotateCcw } from 'lucide-react';
import { useAppTranslation } from '@/i18n';
import { requestAcpRuntime, saveSessionAcpRuntime } from '@/lib/acp-runtime';
import { cn } from '@/lib/utils';
import { useLocalPrefs } from '@/stores/local-prefs';
import { ChipPanel } from './chip-panel';
import { useComposerPopover } from './use-composer-popover';

/** A choice list short enough to show as buttons instead of a select. */
const BUTTONS_UP_TO = 6;

function OptionChoices({
  option,
  value,
  disabled,
  onPick,
}: {
  option: AcpRuntimeOption;
  value: string;
  disabled: boolean;
  onPick: (value: string) => void;
}) {
  if (option.options.length > 1 && option.options.length <= BUTTONS_UP_TO)
    return (
      <fieldset className="m-0 flex flex-wrap gap-1 border-0 p-0" aria-label={option.name}>
        {option.options.map((choice) => {
          const active = choice.value === value;
          return (
            <button
              key={choice.value}
              type="button"
              aria-pressed={active}
              disabled={disabled}
              onClick={() => {
                if (!active) onPick(choice.value);
              }}
              className={cn(
                'border px-2 py-1 text-[11px] transition-colors disabled:opacity-60',
                active
                  ? 'border-primary bg-primary/15 font-medium text-foreground'
                  : 'border-border/60 text-muted-foreground hover:border-border hover:text-foreground',
              )}
            >
              {choice.name}
            </button>
          );
        })}
      </fieldset>
    );
  return (
    <select
      aria-label={option.name}
      disabled={disabled}
      value={value}
      onChange={(event) => onPick(event.target.value)}
      className="w-full min-w-0 border border-border bg-background px-2 py-1 text-xs text-foreground outline-none focus:border-primary"
    >
      {!option.options.some((choice) => choice.value === value) && (
        <option value={value}>{value}</option>
      )}
      {option.options.map((choice) => (
        <option key={choice.value} value={choice.value}>
          {choice.name}
        </option>
      ))}
    </select>
  );
}

/**
 * An ACP session's own model and effort, next to the model chip: the chip says what the agent
 * will run ("opus · high"), the popover sets it. Values apply on the agent's next turn; the
 * agent's permission mode lives on the permission chip.
 */
export function ComposerAcpChip({
  agentId,
  inline = false,
}: {
  agentId: string;
  /** Inside the phone's Run settings dialog: the panel opens under the chip. */
  inline?: boolean | undefined;
}) {
  const { t } = useAppTranslation();
  const settings = useLocalPrefs((s) => s.acpRuntime);
  const sessionId = useLocalPrefs((s) => s.activeSessionId);
  const { open, setOpen, anchorRef, panelRef } = useComposerPopover();
  const runtime = useAcpRuntime({
    agentId,
    values: settings?.[agentId],
    request: requestAcpRuntime,
    onChange: async (values) => {
      const next = { ...settings, [agentId]: values };
      await saveSessionAcpRuntime(next, sessionId);
      useLocalPrefs.getState().set({ acpRuntime: next });
    },
  });
  const { result, busy, saving, error, summary, pendingValues } = runtime;
  const options = result?.options ?? [];
  const ordered = [
    ...options.filter(isModelOption),
    ...options.filter(isEffortOption),
    ...options.filter((option) => !isModelOption(option) && !isEffortOption(option)),
  ];
  const label = summary || t('chat:composerChips.acpDefault', { defaultValue: 'Agent default' });
  return (
    <span
      ref={anchorRef}
      className={cn(inline ? 'flex min-w-0 flex-col items-start' : 'inline-flex min-w-0 shrink')}
    >
      <button
        type="button"
        data-testid="composer-acp-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        title={t('chat:composerChips.acpTitle', {
          defaultValue: '{{agent}} model and effort',
          agent: acpAgentName(agentId),
        })}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next && !result && !busy) void runtime.load(settings?.[agentId] ?? {}, false);
        }}
        className={cn(
          'inline-flex min-w-0 max-w-[18rem] items-center gap-1.5 border border-border/50 bg-card/50 px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:border-primary/30 hover:bg-accent/50 hover:text-foreground',
          open && 'border-primary/40 bg-accent/50 text-foreground',
        )}
      >
        <Brain className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{label}</span>
        {saving ? (
          <LoaderCircle className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
        ) : (
          <ChevronDown className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
        )}
      </button>
      {open && (
        <ChipPanel
          inline={inline}
          anchorRef={anchorRef}
          panelRef={panelRef}
          width={340}
          role="dialog"
          aria-label={t('chat:composerChips.acpTitle', {
            defaultValue: '{{agent}} model and effort',
            agent: acpAgentName(agentId),
          })}
          aria-busy={busy}
          data-testid="composer-acp-popover"
          className="grid gap-3"
        >
          <header className="grid gap-0.5">
            <span className="flex items-center gap-1.5 text-xs font-semibold">
              <Cpu className="h-3.5 w-3.5 text-primary" aria-hidden="true" />
              {acpAgentName(agentId)}
            </span>
            <small className="text-[11px] text-muted-foreground">
              {t('activity:acp.runtimeHint', {
                defaultValue: 'Applies on the next turn or subagent start.',
              })}
            </small>
          </header>
          {busy && !result && (
            <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              {t('activity:acp.runtimeLoading', { defaultValue: 'Reading agent settings…' })}
            </p>
          )}
          {ordered.map((option) => (
            <div key={option.id} className="grid min-w-0 gap-1.5" title={option.description}>
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {option.name}
              </span>
              <OptionChoices
                option={option}
                value={pendingValues?.[option.id] ?? option.currentValue}
                disabled={busy}
                onPick={(value) => runtime.applySelection(option, value)}
              />
            </div>
          ))}
          {result && options.length === 0 && (
            <p className="text-xs text-muted-foreground">
              {t('activity:acp.runtimeUnsupported', {
                defaultValue: 'This agent does not expose model or effort settings through ACP.',
              })}
            </p>
          )}
          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}
          {result && Object.keys(settings?.[agentId] ?? {}).length > 0 && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void runtime.load({}, true)}
              className="inline-flex items-center gap-1.5 justify-self-start text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-60"
            >
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
              {t('activity:acp.runtimeDefaults', { defaultValue: 'Use defaults' })}
            </button>
          )}
        </ChipPanel>
      )}
    </span>
  );
}
