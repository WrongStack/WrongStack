import { acpAgentName } from '@wrongstack/contracts/types/agent-identity';
import type { SwitcherStatus } from '@wrongstack/project-surfaces/providers/switcher-status';
import { Bot, Check, ChevronDown, LoaderCircle, Search, Star } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { ProviderLogo } from '@/components/ProviderLogo';
import { toast } from '@/components/Toaster';
import { type ModelCandidate, useProviderModels } from '@/hooks/useProviderModels';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { applyModelSwitch } from '@/lib/apply-model-switch';
import { cn } from '@/lib/utils';
import { useLocalPrefs } from '@/stores/local-prefs';
import { useProviderQuotaStore } from '@/stores/provider-quota-store';
import { ComposerPopover } from './composer-popover';
import { providerName, type QuickRow, quickRows } from './model-quick-rows';
import { useComposerPopover } from './use-composer-popover';

/** At most this many models hang under an expanded provider; the rest are in "All models". */
const MODELS_SHOWN = 8;

/** The brand mark for a provider, or the agent glyph for an ACP agent (its own brand when known). */
function RowMark({
  row,
  size = 'md',
}: {
  row: Pick<QuickRow, 'provider' | 'providerType' | 'agent' | 'model'>;
  size?: 'sm' | 'md';
}) {
  const box = size === 'sm' ? 'h-5 w-5 p-0.5' : 'h-7 w-7 p-1';
  if (row.agent && row.model) {
    // An ACP agent named after a known vendor ("claude-code") shows that vendor's mark.
    return (
      <span className="relative inline-flex shrink-0">
        <ProviderLogo
          providerId={row.model}
          providerType={row.model.split('-')[0]}
          className={cn(box, 'rounded-md')}
        />
        <Bot
          aria-hidden="true"
          className="absolute -bottom-1 -right-1 h-3 w-3 rounded-full bg-popover p-px text-muted-foreground"
        />
      </span>
    );
  }
  return (
    <ProviderLogo
      providerId={row.provider}
      providerType={row.providerType}
      className={cn(box, 'rounded-md')}
    />
  );
}

function formatTime(epochSeconds: number | undefined): string | undefined {
  if (!epochSeconds) return undefined;
  return new Date(epochSeconds * 1000).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** The one fact on a row's right that decides whether to pick it: plan quota left, or cut off. */
function RowStatus({ status }: { status: SwitcherStatus }) {
  const { t } = useAppTranslation();
  if (status.kind === 'reached') {
    const time = formatTime(status.resetsAt);
    return (
      <span className="shrink-0 text-[11px] font-medium text-destructive">
        {time
          ? t('chat:composerChips.limitReachedAt', {
              defaultValue: 'Limit reached · {{time}}',
              time,
            })
          : t('chat:composerChips.limitReached', { defaultValue: 'Limit reached' })}
      </span>
    );
  }
  if (status.kind !== 'quota') return null;
  const tone =
    status.level === 'critical'
      ? 'bg-destructive'
      : status.level === 'warn'
        ? 'bg-warning'
        : 'bg-success';
  return (
    <span className="grid shrink-0 justify-items-end gap-1 text-[11px] tabular-nums text-muted-foreground">
      <span className={cn(status.level === 'critical' && 'text-destructive')}>
        {t('chat:composerChips.quotaLeft', {
          defaultValue: '{{window}} · {{percent}}% left',
          window: status.window,
          percent: status.left,
        })}
      </span>
      <span className="block h-1 w-16 overflow-hidden rounded-full bg-muted">
        <span
          className={cn('block h-full rounded-full', tone)}
          style={{ width: `${status.left}%` }}
        />
      </span>
    </span>
  );
}

/**
 * The composer's model chip: the provider's mark, its name and the model, opening a light list
 * of providers and ACP agents with their plan status. A provider row expands to its models; an
 * agent row switches straight away. "All models and search…" keeps the full switcher.
 */
export function ComposerModelChip({
  provider,
  model,
  onOpenAll,
}: {
  provider: string;
  model: string;
  onOpenAll: () => void;
}) {
  const { t } = useAppTranslation();
  const { open, setOpen, anchorRef, panelRef } = useComposerPopover();
  const candidates = useProviderModels(open);
  const meters = useProviderQuotaStore((s) => s.meters);
  const { switchModel } = useWebSocket();
  const keyboardShortcuts = useLocalPrefs((s) => s.keyboardShortcuts);
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘M' : 'Ctrl M';
  const [expanded, setExpanded] = useState<string | null>(null);
  const [switching, setSwitching] = useState<string | null>(null);
  const firstRowRef = useRef<HTMLButtonElement | null>(null);
  const isAgent = provider === 'acp';
  const rows = useMemo(
    () =>
      quickRows({
        candidates,
        session: { provider, model },
        quota: Object.values(meters),
      }),
    [candidates, provider, model, meters],
  );
  const groups = [
    { agent: isAgent, rows: rows.filter((row) => row.agent === isAgent) },
    { agent: !isAgent, rows: rows.filter((row) => row.agent !== isAgent) },
  ].filter((group) => group.rows.length > 0);

  const choose = async (target: { provider: string; model: string }) => {
    if (switching) return;
    if (target.provider === provider && target.model === model) {
      setOpen(false);
      return;
    }
    const label = `${target.provider} / ${target.model}`;
    setSwitching(label);
    const result = await switchModel(target.provider, target.model);
    setSwitching(null);
    if (!result.success) {
      toast.error(result.message);
      return;
    }
    applyModelSwitch(target);
    toast.success(
      t(
        result.runActive
          ? 'settings:toast.modelSwitchedRunActive'
          : 'settings:toast.modelSwitchedNextRequest',
        { from: `${provider} / ${model}`, to: label },
      ),
    );
    setOpen(false);
  };

  const name = isAgent ? acpAgentName(model) : providerName(provider);
  const shownModel = isAgent ? '' : model;
  return (
    <span ref={anchorRef} className="inline-flex min-w-0 max-w-[min(26rem,100%)] shrink">
      <button
        type="button"
        data-testid="composer-model-chip"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        title={t('chat:header.changeModelTitle')}
        className={cn(
          'ws-model-chip inline-flex w-full min-w-0 items-center gap-2 border border-border/50 bg-card/50 py-1 pl-1 pr-2 text-xs transition-colors duration-150 hover:border-primary/30 hover:bg-accent/50',
          open && 'border-primary/40 bg-accent/50',
        )}
      >
        {provider ? (
          <RowMark size="sm" row={{ provider, agent: isAgent, model, providerType: undefined }} />
        ) : null}
        <span className="shrink-0 font-medium text-foreground">
          {name || t('chat:header.noProvider')}
        </span>
        {shownModel && (
          <span className="min-w-0 truncate font-mono text-muted-foreground">{shownModel}</span>
        )}
        <ChevronDown className="h-3 w-3 shrink-0 opacity-60" aria-hidden="true" />
      </button>
      {open && (
        <ComposerPopover
          anchorRef={anchorRef}
          panelRef={panelRef}
          initialFocusRef={firstRowRef}
          width={380}
          role="dialog"
          aria-label={t('chat:composerChips.switchModel', { defaultValue: 'Switch model' })}
          aria-busy={switching !== null}
          data-testid="composer-model-popover"
          className="grid gap-1 p-1.5"
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            const buttons = [
              ...(panelRef.current?.querySelectorAll<HTMLButtonElement>('[data-quick-pick]') ?? []),
            ];
            const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
            const next = buttons[index + (event.key === 'ArrowDown' ? 1 : -1)];
            if (next) {
              event.preventDefault();
              next.focus();
            }
          }}
        >
          {rows.length === 0 && (
            <p className="flex items-center gap-2 px-2 py-3 text-xs text-muted-foreground">
              <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              {t('activity:model.loading')}
            </p>
          )}
          {groups.map((group, groupIndex) => (
            <section key={String(group.agent)} className="grid gap-0.5">
              <h3 className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                {group.agent
                  ? t('chat:composerChips.agents', { defaultValue: 'Agents' })
                  : t('chat:composerChips.providers', { defaultValue: 'Providers' })}
              </h3>
              {group.rows.map((row, rowIndex) => {
                const isOpen = expanded === row.key;
                const pick = () => {
                  if (row.agent && row.model)
                    void choose({ provider: row.provider, model: row.model });
                  else setExpanded(isOpen ? null : row.key);
                };
                return (
                  <div key={row.key} className={cn(row.current && 'bg-primary/10')}>
                    <button
                      type="button"
                      data-quick-pick=""
                      ref={groupIndex === 0 && rowIndex === 0 ? firstRowRef : undefined}
                      aria-current={row.current ? 'true' : undefined}
                      aria-expanded={row.agent ? undefined : isOpen}
                      disabled={switching !== null}
                      onClick={pick}
                      className="flex w-full min-w-0 items-center gap-2.5 px-2 py-1.5 text-left hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none disabled:cursor-progress"
                    >
                      <RowMark row={row} />
                      <span className="grid min-w-0 flex-1 gap-0.5">
                        <span className="break-words text-[13px] font-medium text-foreground">
                          {row.name}
                        </span>
                        {(row.model && !row.agent) || row.models.length > 0 ? (
                          <span className="break-all font-mono text-[11px] text-muted-foreground">
                            {row.model && !row.agent
                              ? row.model
                              : t('chat:composerChips.modelCount', {
                                  defaultValue: '{{count}} models',
                                  count: row.models.length,
                                })}
                          </span>
                        ) : null}
                      </span>
                      <RowStatus status={row.status} />
                      {row.current && (
                        <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" />
                      )}
                      {!row.agent && (
                        <ChevronDown
                          aria-hidden="true"
                          className={cn(
                            'h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform',
                            isOpen && 'rotate-180',
                          )}
                        />
                      )}
                    </button>
                    {isOpen && (
                      <ModelList
                        row={row}
                        session={{ provider, model }}
                        switching={switching}
                        onChoose={(candidate) =>
                          void choose({ provider: candidate.provider, model: candidate.model })
                        }
                        onOpenAll={() => {
                          setOpen(false);
                          onOpenAll();
                        }}
                      />
                    )}
                  </div>
                );
              })}
            </section>
          ))}
          <div className="mt-0.5 border-t border-border/60 pt-1">
            <button
              type="button"
              data-quick-pick=""
              data-testid="composer-model-all"
              onClick={() => {
                setOpen(false);
                onOpenAll();
              }}
              className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:bg-accent/60 focus-visible:outline-none"
            >
              <Search className="h-3.5 w-3.5" aria-hidden="true" />
              <span className="flex-1">
                {t('chat:composerChips.allModels', { defaultValue: 'All models and search…' })}
              </span>
              {keyboardShortcuts && (
                <kbd className="font-mono text-[10px] opacity-70">{shortcut}</kbd>
              )}
            </button>
          </div>
        </ComposerPopover>
      )}
    </span>
  );
}

function ModelList({
  row,
  session,
  switching,
  onChoose,
  onOpenAll,
}: {
  row: QuickRow;
  session: { provider: string; model: string };
  switching: string | null;
  onChoose: (candidate: ModelCandidate) => void;
  onOpenAll: () => void;
}) {
  const { t } = useAppTranslation();
  const shown = row.models.slice(0, MODELS_SHOWN);
  const more = row.models.length - shown.length;
  return (
    <div className="mb-1 ml-[2.6rem] mr-1 grid gap-px border-l border-border/70 pl-1.5">
      {shown.length === 0 && (
        <p className="px-2 py-1.5 text-[11px] text-muted-foreground">
          {t('chat:composerChips.noModels', { defaultValue: 'No models available.' })}
        </p>
      )}
      {shown.map((candidate) => {
        const current =
          candidate.provider === session.provider && candidate.model === session.model;
        return (
          <button
            key={candidate.model}
            type="button"
            data-quick-pick=""
            aria-current={current ? 'true' : undefined}
            disabled={switching !== null}
            onClick={() => onChoose(candidate)}
            className={cn(
              'flex min-w-0 items-center gap-2 px-2 py-1 text-left text-xs hover:bg-accent/60 focus-visible:bg-accent/60 focus-visible:outline-none disabled:cursor-progress',
              current ? 'font-semibold text-primary' : 'text-foreground',
            )}
          >
            <span className="min-w-0 flex-1 break-all">{candidate.label}</span>
            {candidate.isFavorite && (
              <Star className="h-3 w-3 shrink-0 fill-warning text-warning" aria-hidden="true" />
            )}
            {candidate.contextWindow ? (
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                {Math.round(candidate.contextWindow / 1000)}k
              </span>
            ) : null}
          </button>
        );
      })}
      {more > 0 && (
        <button
          type="button"
          data-quick-pick=""
          onClick={onOpenAll}
          className="px-2 py-1 text-left text-[11px] text-muted-foreground hover:bg-accent/60 hover:text-foreground focus-visible:bg-accent/60 focus-visible:outline-none"
        >
          {t('chat:composerChips.moreModels', { defaultValue: '+{{count}} more…', count: more })}
        </button>
      )}
    </div>
  );
}
