import { ArrowDown, ArrowUp, Brain, Loader2, Plus, X } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import { useAppTranslation } from '@/i18n';
import { cn } from '@/lib/utils';
import { useActiveSessionId } from '@/stores';
import type {
  BrainConfigPatchWire,
  BrainConfigWire,
  BrainCouncilVoterWire,
  WSServerMessage,
} from '@/types';
import { ModelSelectDialog } from '../ModelSelectDialog';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  CACHE_MAX_ENTRIES,
  CACHE_TTLS,
  COUNCIL_CALL_TIMEOUTS,
  COUNCIL_CONCURRENCY,
  councilPersonaOptions,
  DECISION_LOG_SIZES,
  DECISION_TIMEOUTS,
  DELIBERATION_ROUNDS,
  entryLabel,
  FRACTIONS,
  HUMAN_TIMEOUTS,
  INTERVENTION_WINDOWS,
  JUDGE_MAX_TOKENS,
  LEDGER_MEMORY_ENTRIES,
  LLM_MAX_TOKENS,
  localizeOptions,
  MIN_CONFIDENCE,
  optionalValue,
  PICK_TITLES,
  type PickTarget,
  RISK_COPY,
  RISK_LEVELS,
  RiskDot,
  type RiskLevel,
  VOTER_MAX_TOKENS,
  withCurrent,
} from './brain-section-options';
import { PreferenceSelect } from './PreferenceControls';
import { PreferenceToggle } from './PreferenceToggle';
export function BrainSection(): ReactElement {
  const { t } = useAppTranslation();
  const { client } = useWebSocket();
  const [config, setConfig] = useState<BrainConfigWire | null>(null);
  const [log, setLog] = useState<
    Array<{ kind: string; question: string; outcome: string; age: string }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [persistError, setPersistError] = useState<string | null>(null);
  const [pickTarget, setPickTarget] = useState<PickTarget>(null);

  // The Brain is project-wide; its DECISIONS are not. Each entry names the
  // session whose tool call it was about, and the server filters the log to
  // the session that asked. Asking untagged got this panel an unlabelled
  // mixture of all four open tabs' decisions.
  const sessionId = useActiveSessionId();

  // Fetch brain status + editable config on mount, and again when the tab in
  // front changes — the panel is parked, not unmounted, so without the re-ask
  // it keeps showing the previous tab's decisions.
  useEffect(() => {
    client.send({ type: 'brain.status', payload: client.withSession({}) });
    client.send({ type: 'brain.config.get' });
  }, [client, sessionId]);

  // Listen for brain status/config responses
  useEffect(() => {
    const offStatus = client.on('brain.status', (msg: WSServerMessage) => {
      const p = msg.payload as {
        maxAutoRisk: string;
        sessionId?: string | undefined;
        log: Array<{ at: number; kind: string; question: string; outcome: string }>;
      };
      // A stamped frame for another tab is not ours to render. Untagged stays
      // accepted: single-session hosts answer without a stamp.
      if (p.sessionId && sessionId && p.sessionId !== sessionId) return;
      const now = Date.now();
      setLog(
        p.log.slice(-10).map((entry) => {
          const s = Math.max(0, Math.round((now - entry.at) / 1000));
          const age =
            s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : `${Math.round(s / 3600)}h`;
          return { kind: entry.kind, question: entry.question, outcome: entry.outcome, age };
        }),
      );
      setLoading(false);
    });
    const offConfig = client.on('brain.config', (msg: WSServerMessage) => {
      const p = msg.payload as { config: BrainConfigWire; persisted: boolean; error?: string };
      setConfig(p.config);
      setPersistError(p.persisted ? null : (p.error ?? t('settings:brain.persistError')));
      setBusy(false);
      setLoading(false);
    });
    return () => {
      offStatus();
      offConfig();
    };
  }, [client, t, sessionId]);

  /** Every control funnels here: live-apply + persist on the server, reconcile on reply. */
  const sendPatch = useCallback(
    (patch: BrainConfigPatchWire) => {
      setBusy(true);
      // Stamped so the status frame the server sends back after applying the
      // patch comes home to this tab rather than the runtime's.
      client.send({ type: 'brain.config.set', payload: client.withSession({ patch }) });
    },
    [client],
  );

  const handleRiskChange = useCallback(
    (level: RiskLevel) => {
      setConfig((prev) => (prev ? { ...prev, maxAutoRisk: level } : prev));
      sendPatch({ maxAutoRisk: level });
    },
    [sendPatch],
  );

  const voters: BrainCouncilVoterWire[] = useMemo(() => config?.council.voters ?? [], [config]);

  const setVoters = useCallback(
    (next: BrainCouncilVoterWire[]) => {
      sendPatch({ council: { voters: next.length > 0 ? next : null } });
    },
    [sendPatch],
  );

  // Lens picker options come from the SERVER's persona registry, so a lens
  // added in core shows up here without touching this file. Older servers send
  // no catalog and fall back to the three lenses this section used to inline.
  const personaOptions = useMemo(
    () => councilPersonaOptions(config?.personaCatalog),
    [config?.personaCatalog],
  );

  const riskLevel: RiskLevel = (RISK_LEVELS as readonly string[]).includes(
    config?.maxAutoRisk ?? '',
  )
    ? ((config?.maxAutoRisk ?? 'medium') as RiskLevel)
    : 'medium';

  /** Shared picker resolution: route the selection to pool / voters / judge. */
  const handleModelPicked = useCallback(
    (candidate: { provider: string; model: string }): boolean | undefined => {
      if (!config || !pickTarget) return undefined;
      const ref = `${candidate.provider}/${candidate.model}`;
      if (pickTarget === 'pool') {
        sendPatch({ models: [...config.models.map(entryLabel), ref] });
        return undefined;
      }
      if (pickTarget === 'judge') {
        sendPatch({ council: { judge: ref } });
        return undefined;
      }
      // voter: multi-add — keep the dialog open until the user closes it.
      setVoters([
        ...voters,
        {
          provider: candidate.provider,
          model: candidate.model,
          persona: personaOptions[voters.length % personaOptions.length]?.id ?? 'executor',
        },
      ]);
      return true;
    },
    [config, personaOptions, pickTarget, sendPatch, setVoters, voters],
  );

  return (
    <div className="space-y-4">
      <ModelSelectDialog
        open={pickTarget !== null}
        mode="provider-model"
        title={pickTarget ? t(PICK_TITLES[pickTarget].title) : ''}
        hint={pickTarget ? t(PICK_TITLES[pickTarget].hint) : undefined}
        onPick={(result) => {
          if (result.type !== 'provider-model') return;
          return handleModelPicked(result);
        }}
        onClose={() => setPickTarget(null)}
      />
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-md border border-primary/20 bg-primary/10 text-primary">
          <Brain className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h3 className="text-base font-semibold">{t('settings:brain.heading')}</h3>
          <p className="text-xs text-muted-foreground">{t('settings:brain.headingHint')}</p>
        </div>
        {(loading || busy) && (
          <Loader2 className="ml-auto h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>

      {persistError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {persistError}
        </div>
      )}

      {/* Risk ceiling */}
      <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 p-3">
        <span className="text-sm font-medium">{t('settings:brain.riskHeading')}</span>
        <div className="flex gap-2 flex-wrap">
          {RISK_LEVELS.map((level) => (
            <Button
              key={level}
              variant={riskLevel === level ? 'default' : 'outline'}
              size="sm"
              className={cn('gap-1.5 text-xs', riskLevel === level && 'shadow-sm')}
              disabled={busy}
              onClick={() => handleRiskChange(level)}
            >
              <RiskDot level={level} />
              {level.toUpperCase()}
            </Button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t(RISK_COPY[riskLevel])}</p>
      </div>

      {config && (
        <>
          {/* Escalation */}
          <div className="space-y-1 rounded-md border border-border/70 bg-muted/20 p-3">
            <span className="text-sm font-medium">{t('settings:brain.escalationHeading')}</span>
            <PreferenceSelect
              label={t('settings:brain.escalationModeLabel')}
              hint={t('settings:brain.escalationModeHint')}
              value={config.mode}
              options={[
                { value: 'interactive', label: t('settings:brain.optInteractive') },
                { value: 'headless', label: t('settings:brain.optHeadless') },
              ]}
              onChange={(mode) => sendPatch({ mode })}
              disabled={busy}
            />
            <PreferenceSelect
              label={t('settings:brain.escalationDecisionTimeoutLabel')}
              hint={t('settings:brain.escalationDecisionTimeoutHint')}
              value={config.decisionTimeoutMs ? String(config.decisionTimeoutMs) : 'default'}
              options={localizeOptions(DECISION_TIMEOUTS, t)}
              onChange={(v) => sendPatch({ decisionTimeoutMs: v === 'default' ? null : Number(v) })}
              disabled={busy}
            />
            <PreferenceSelect
              label={t('settings:brain.escalationHumanTimeoutLabel')}
              hint={t('settings:brain.escalationHumanTimeoutHint')}
              value={config.humanTimeoutMs ? String(config.humanTimeoutMs) : 'off'}
              options={localizeOptions(HUMAN_TIMEOUTS, t)}
              onChange={(v) => sendPatch({ humanTimeoutMs: v === 'off' ? null : Number(v) })}
              disabled={busy}
            />
            <PreferenceSelect
              label={t('settings:brain.escalationTerminalPolicyLabel')}
              hint={t('settings:brain.escalationTerminalPolicyHint')}
              value={config.terminalPolicy}
              options={[
                { value: 'conservative', label: t('settings:brain.optConservative') },
                { value: 'deny-all', label: t('settings:brain.optDenyAll') },
                {
                  value: 'continue-on-recommended',
                  label: t('settings:brain.optContinueRecommended'),
                },
              ]}
              onChange={(terminalPolicy) => sendPatch({ terminalPolicy })}
              disabled={busy}
            />
            <PreferenceSelect
              label={t('settings:brain.escalationDecisionLogSizeLabel')}
              hint={t('settings:brain.escalationDecisionLogSizeHint')}
              value={String(config.decisionLogMaxEntries)}
              options={localizeOptions(
                withCurrent(DECISION_LOG_SIZES, String(config.decisionLogMaxEntries)),
                t,
              )}
              onChange={(v) => sendPatch({ decisionLogMaxEntries: Number(v) })}
              disabled={busy}
            />
          </div>

          {/* Deterministic rules (read-only) */}
          <div className="space-y-1 rounded-md border border-border/70 bg-muted/20 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{t('settings:brain.rulesHeading')}</span>
              <Badge variant="outline" className="text-[10px]">
                {t('settings:brain.rulesConfigured', { count: config.rules.length })}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">{t('settings:brain.rulesBody')}</p>
            {config.rules.length > 0 && (
              <div className="space-y-1">
                {config.rules.map((rule, i) => (
                  <div
                    key={`${rule.id}-${i}`}
                    className="flex items-center gap-2 rounded-md border border-border/50 bg-background/40 px-2 py-1.5 text-xs"
                  >
                    <span className="text-muted-foreground w-4 shrink-0">{i + 1}.</span>
                    <span className="flex-1 truncate font-mono">{rule.id}</span>
                    <Badge variant="outline" className="text-[10px] shrink-0">
                      {rule.then.action}
                    </Badge>
                    {rule.enabled === false && (
                      <Badge variant="outline" className="text-[10px] shrink-0">
                        {t('settings:brain.rulesOff')}
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            )}
            {config.ruleErrors.length > 0 && (
              <div className="space-y-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5">
                <span className="text-xs font-medium text-warning">
                  {t('settings:brain.rulesDropped', { count: config.ruleErrors.length })}
                </span>
                {config.ruleErrors.map((err) => (
                  <p key={err} className="text-xs text-warning">
                    {err}
                  </p>
                ))}
              </div>
            )}
          </div>

          {/* Heuristics */}
          <div className="space-y-1 rounded-md border border-border/70 bg-muted/20 p-3">
            <span className="text-sm font-medium">{t('settings:brain.heuristicsHeading')}</span>
            <p className="text-xs text-muted-foreground">{t('settings:brain.heuristicsBody')}</p>
            <PreferenceToggle
              label={t('settings:brain.heuristicsLowRiskLabel')}
              hint={t('settings:brain.heuristicsLowRiskHint')}
              value={config.heuristics.lowRiskAutoAnswer}
              onChange={() =>
                sendPatch({
                  heuristics: { lowRiskAutoAnswer: !config.heuristics.lowRiskAutoAnswer },
                })
              }
              disabled={busy}
            />
            <PreferenceToggle
              label={t('settings:brain.heuristicsBlockedLabel')}
              hint={t('settings:brain.heuristicsBlockedHint')}
              value={config.heuristics.blockedResolved}
              onChange={() =>
                sendPatch({ heuristics: { blockedResolved: !config.heuristics.blockedResolved } })
              }
              disabled={busy}
            />
            <PreferenceToggle
              label={t('settings:brain.heuristicsDeadlockLabel')}
              hint={t('settings:brain.heuristicsDeadlockHint')}
              value={config.heuristics.deadlockSkip}
              onChange={() =>
                sendPatch({ heuristics: { deadlockSkip: !config.heuristics.deadlockSkip } })
              }
              disabled={busy}
            />
            <PreferenceToggle
              label={t('settings:brain.heuristicsRetryLabel')}
              hint={t('settings:brain.heuristicsRetryHint')}
              value={config.heuristics.retryExhausted}
              onChange={() =>
                sendPatch({ heuristics: { retryExhausted: !config.heuristics.retryExhausted } })
              }
              disabled={busy}
            />
            <PreferenceToggle
              label={t('settings:brain.heuristicsPingLabel')}
              hint={t('settings:brain.heuristicsPingHint')}
              value={config.heuristics.continuePing}
              onChange={() =>
                sendPatch({ heuristics: { continuePing: !config.heuristics.continuePing } })
              }
              disabled={busy}
            />
            {config.heuristics.blockedResolvedMarkers &&
              config.heuristics.blockedResolvedMarkers.length > 0 && (
                <p className="truncate text-xs text-muted-foreground">
                  {t('settings:brain.heuristicsMarkers', {
                    markers: config.heuristics.blockedResolvedMarkers.join(', '),
                  })}
                </p>
              )}
          </div>

          {/* LLM quality gate */}
          <div className="space-y-1 rounded-md border border-border/70 bg-muted/20 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{t('settings:brain.qualityHeading')}</span>
              {config.circuit && (
                <Badge
                  variant={config.circuit.state === 'closed' ? 'outline' : 'default'}
                  className="text-[10px]"
                >
                  {t('settings:brain.qualityCircuit', {
                    state: config.circuit.state,
                    count: config.circuit.consecutiveFailures,
                  })}
                </Badge>
              )}
            </div>
            <PreferenceSelect
              label={t('settings:brain.qualityResponseBudgetLabel')}
              hint={t('settings:brain.qualityResponseBudgetHint')}
              value={String(config.llm.maxTokens)}
              options={localizeOptions(
                withCurrent(LLM_MAX_TOKENS, String(config.llm.maxTokens)),
                t,
              )}
              onChange={(v) => sendPatch({ llm: { maxTokens: Number(v) } })}
              disabled={busy}
            />
            <PreferenceToggle
              label={t('settings:brain.qualityRejectLabel')}
              hint={t('settings:brain.qualityRejectHint')}
              value={config.llm.rejectUncertain}
              onChange={() => sendPatch({ llm: { rejectUncertain: !config.llm.rejectUncertain } })}
              disabled={busy}
            />
            <PreferenceSelect
              label={t('settings:brain.qualityMinConfidenceLabel')}
              hint={t('settings:brain.qualityMinConfidenceHint')}
              value={String(config.llm.minConfidence)}
              options={localizeOptions(
                withCurrent(MIN_CONFIDENCE, String(config.llm.minConfidence)),
                t,
              )}
              onChange={(v) => sendPatch({ llm: { minConfidence: Number(v) } })}
              disabled={busy}
            />
            <PreferenceSelect
              label={t('settings:brain.qualityDenyTerminalLabel')}
              hint={t('settings:brain.qualityDenyTerminalHint')}
              value={config.llm.denyIsTerminal}
              options={[
                { value: 'never', label: t('settings:brain.optNeverDefault') },
                { value: 'when-decided', label: t('settings:brain.optWhenDecided') },
                { value: 'always', label: t('settings:brain.optAlways') },
              ]}
              onChange={(denyIsTerminal) => sendPatch({ llm: { denyIsTerminal } })}
              disabled={busy}
            />
          </div>

          {/* Replay trace */}
          <div className="space-y-1 rounded-md border border-border/70 bg-muted/20 p-3">
            <span className="text-sm font-medium">{t('settings:brain.traceHeading')}</span>
            <PreferenceToggle
              label={t('settings:brain.traceRecordLabel')}
              hint={t('settings:brain.traceRecordHint')}
              value={config.trace.enabled}
              onChange={() => sendPatch({ trace: { enabled: !config.trace.enabled } })}
              disabled={busy}
            />
            <PreferenceSelect
              label={t('settings:brain.traceContentLabel')}
              hint={t('settings:brain.traceContentHint')}
              value={config.trace.content}
              options={[
                { value: 'full', label: t('settings:brain.optFullDefault') },
                { value: 'redacted', label: t('settings:brain.optRedacted') },
                { value: 'none', label: t('settings:brain.optMetadataOnly') },
              ]}
              onChange={(content) => sendPatch({ trace: { content } })}
              disabled={busy}
            />
            {config.trace.path && (
              <p className="truncate text-xs text-muted-foreground">{config.trace.path}</p>
            )}
          </div>

          {/* Decision cache */}
          <div className="space-y-1 rounded-md border border-border/70 bg-muted/20 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{t('settings:brain.cacheHeading')}</span>
              <Badge variant="outline" className="text-[10px]">
                {t('settings:brain.cacheStats', {
                  hits: config.cache.hits,
                  misses: config.cache.misses,
                  size: config.cache.size,
                })}
              </Badge>
            </div>
            <PreferenceToggle
              label={t('settings:brain.cacheReplayLabel')}
              hint={t('settings:brain.cacheReplayHint')}
              value={config.cache.enabled}
              onChange={() => sendPatch({ cache: { enabled: !config.cache.enabled } })}
              disabled={busy}
            />
            <PreferenceSelect
              label={t('settings:brain.cacheLifetimeLabel')}
              hint={t('settings:brain.cacheLifetimeHint')}
              value={String(config.cache.ttlMs)}
              options={localizeOptions(withCurrent(CACHE_TTLS, String(config.cache.ttlMs)), t)}
              onChange={(v) => sendPatch({ cache: { ttlMs: Number(v) } })}
              disabled={busy}
            />
            <PreferenceSelect
              label={t('settings:brain.cacheMaxEntriesLabel')}
              hint={t('settings:brain.cacheMaxEntriesHint')}
              value={String(config.cache.maxEntries)}
              options={localizeOptions(
                withCurrent(CACHE_MAX_ENTRIES, String(config.cache.maxEntries)),
                t,
              )}
              onChange={(v) => sendPatch({ cache: { maxEntries: Number(v) } })}
              disabled={busy}
            />
          </div>

          {/* Monitor */}
          <div className="space-y-1 rounded-md border border-border/70 bg-muted/20 p-3">
            <span className="text-sm font-medium">{t('settings:brain.monitorHeading')}</span>
            <p className="text-xs text-muted-foreground">{t('settings:brain.monitorBody')}</p>
            <PreferenceToggle
              label={t('settings:brain.monitorWatchLabel')}
              hint={t('settings:brain.monitorWatchHint')}
              value={config.monitor.enabled !== false}
              onChange={() => sendPatch({ monitor: { enabled: config.monitor.enabled === false } })}
              disabled={busy}
            />
            <PreferenceSelect
              label={t('settings:brain.monitorPolicyLabel')}
              hint={t('settings:brain.monitorPolicyHint')}
              value={config.monitor.policy ?? 'llm'}
              options={[
                { value: 'llm', label: t('settings:brain.optConsultBrain') },
                { value: 'steer', label: t('settings:brain.optAlwaysSteer') },
                { value: 'observe', label: t('settings:brain.optObserveOnly') },
              ]}
              onChange={(policy) => sendPatch({ monitor: { policy } })}
              disabled={busy}
            />
          </div>

          {/* Decision models */}
          <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{t('settings:brain.modelsHeading')}</span>
              <Badge variant="outline" className="text-[10px]">
                {config.usingSessionModel
                  ? t('settings:brain.modelsSessionBadge')
                  : t('settings:brain.modelsResolvedBadge', {
                      resolved: config.poolLabels.length,
                      total: config.models.length,
                    })}
              </Badge>
            </div>
            <PreferenceToggle
              label={t('settings:brain.modelsUseSessionLabel')}
              hint={t('settings:brain.modelsUseSessionHint')}
              value={config.usingSessionModel}
              onChange={() => {
                if (!config.usingSessionModel) sendPatch({ models: null });
              }}
              disabled={busy}
            />
            {config.models.length > 0 && (
              <div className="space-y-1">
                {config.models.map((entry, i) => (
                  <div
                    key={`${entryLabel(entry)}-${i}`}
                    className="flex items-center gap-2 rounded-md border border-border/50 bg-background/40 px-2 py-1.5 text-xs"
                  >
                    <span className="text-muted-foreground w-4 shrink-0">{i + 1}.</span>
                    <span className="flex-1 truncate font-mono">{entryLabel(entry)}</span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      disabled={busy || i === 0}
                      onClick={() => {
                        const next = config.models.map(entryLabel);
                        const item = next.splice(i, 1)[0];
                        if (item) next.splice(i - 1, 0, item);
                        sendPatch({ models: next });
                      }}
                    >
                      <ArrowUp className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0"
                      disabled={busy || i === config.models.length - 1}
                      onClick={() => {
                        const next = config.models.map(entryLabel);
                        const item = next.splice(i, 1)[0];
                        if (item) next.splice(i + 1, 0, item);
                        sendPatch({ models: next });
                      }}
                    >
                      <ArrowDown className="h-3 w-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-destructive"
                      disabled={busy}
                      onClick={() => {
                        const next = config.models.map(entryLabel).filter((_, j) => j !== i);
                        sendPatch({ models: next.length > 0 ? next : null });
                      }}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              disabled={busy}
              onClick={() => setPickTarget('pool')}
            >
              <Plus className="h-3.5 w-3.5" /> {t('settings:brain.modelsAddModel')}
            </Button>
            {config.models.length > 1 && (
              <PreferenceSelect
                label={t('settings:brain.modelsPoolStrategyLabel')}
                hint={t('settings:brain.modelsPoolStrategyHint')}
                value={config.strategy}
                options={[
                  { value: 'fallback', label: t('settings:brain.optFallback') },
                  { value: 'round-robin', label: t('settings:brain.optRoundRobin') },
                ]}
                onChange={(strategy) => sendPatch({ strategy })}
                disabled={busy}
              />
            )}
          </div>

          {/* Council */}
          <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">{t('settings:brain.councilHeading')}</span>
              <Badge
                variant={config.council.enabled ? 'default' : 'outline'}
                className="text-[10px]"
              >
                {config.council.enabled
                  ? t('settings:brain.councilConvened')
                  : t('settings:brain.councilDisabled')}
              </Badge>
            </div>
            <PreferenceToggle
              label={t('settings:brain.councilEnableLabel')}
              hint={t('settings:brain.councilEnableHint')}
              value={config.council.enabled}
              onChange={() => sendPatch({ council: { enabled: !config.council.enabled } })}
              disabled={busy}
            />
            {config.council.enabled && config.councilLabels.length > 0 && voters.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {t('settings:brain.councilSeatsDerived', {
                  seats: config.councilLabels.join(', '),
                })}
              </p>
            )}
            {voters.length > 0 && (
              <div className="space-y-1">
                {voters.map((voter, i) => (
                  <div
                    key={`${entryLabel(voter)}-${i}`}
                    className="flex items-center gap-2 rounded-md border border-border/50 bg-background/40 px-2 py-1.5 text-xs"
                  >
                    <span className="flex-1 truncate font-mono">{entryLabel(voter)}</span>
                    <select
                      value={voter.persona ?? personaOptions[i % personaOptions.length]?.id ?? ''}
                      onChange={(e) =>
                        setVoters(
                          voters.map((v, j) => (j === i ? { ...v, persona: e.target.value } : v)),
                        )
                      }
                      className="h-6 rounded border bg-background px-1 text-[10px]"
                      title={
                        personaOptions.find((p) => p.id === voter.persona)?.description ??
                        t('settings:brain.councilCustomLens')
                      }
                    >
                      {personaOptions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                      {voter.persona && !personaOptions.some((p) => p.id === voter.persona) && (
                        <option value={voter.persona}>
                          {t('settings:brain.councilCustomOption', { persona: voter.persona })}
                        </option>
                      )}
                    </select>
                    <Button
                      variant={voter.veto ? 'default' : 'outline'}
                      size="sm"
                      className="h-6 px-1.5 text-[10px]"
                      disabled={busy}
                      onClick={() =>
                        setVoters(voters.map((v, j) => (j === i ? { ...v, veto: !v.veto } : v)))
                      }
                    >
                      {t('settings:brain.councilVeto')}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 text-destructive"
                      disabled={busy}
                      onClick={() => setVoters(voters.filter((_, j) => j !== i))}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              disabled={busy}
              onClick={() => setPickTarget('voter')}
            >
              <Plus className="h-3.5 w-3.5" /> {t('settings:brain.councilAddVoter')}
            </Button>
            <PreferenceSelect
              label={t('settings:brain.councilRiskFloorLabel')}
              hint={t('settings:brain.councilRiskFloorHint')}
              value={config.council.minRisk}
              options={[
                { value: 'medium', label: t('settings:brain.optMediumPlus') },
                { value: 'high', label: t('settings:brain.optHighPlus') },
                { value: 'critical', label: t('settings:brain.optCriticalOnly') },
              ]}
              onChange={(minRisk) => sendPatch({ council: { minRisk } })}
              disabled={busy}
            />
            <div className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">{t('settings:brain.councilJudge')}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {t('settings:brain.councilJudgeDesc')}
                </div>
                {/*
                  On 'auto' the judge is derived from the pool, and when the
                  pool has no model left over after seating it ends up being
                  one of the voters — a tie-breaker that cast one of the tied
                  votes. Surface the resolved judge so that is visible instead
                  of implicit.
                */}
                {!config.council.judge && config.judgeLabel && (
                  <div className="mt-0.5 font-mono text-xs text-muted-foreground">
                    {t('settings:brain.councilResolved', { model: config.judgeLabel })}
                    {config.judgeIsVoter && (
                      <span className="ml-1 font-sans text-warning">
                        {t('settings:brain.councilAlsoVoter')}
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <span className="max-w-[180px] truncate font-mono text-xs">
                  {config.council.judge
                    ? entryLabel(config.council.judge)
                    : t('settings:brain.councilAuto')}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={busy}
                  onClick={() => setPickTarget('judge')}
                >
                  {t('settings:brain.councilPick')}
                </Button>
                {config.council.judge && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={busy}
                    onClick={() => sendPatch({ council: { judge: null } })}
                  >
                    {t('settings:brain.councilAutoReset')}
                  </Button>
                )}
              </div>
            </div>
            <PreferenceSelect
              label={t('settings:brain.councilQuorumLabel')}
              hint={t('settings:brain.councilQuorumHint')}
              value={
                config.council.quorum !== undefined ? String(config.council.quorum) : 'default'
              }
              options={localizeOptions(FRACTIONS, t)}
              onChange={(v) =>
                sendPatch({ council: { quorum: v === 'default' ? null : Number(v) } })
              }
              disabled={busy}
            />
            <PreferenceSelect
              label={t('settings:brain.councilApprovalLabel')}
              hint={t('settings:brain.councilApprovalHint')}
              value={
                config.council.approval !== undefined ? String(config.council.approval) : 'default'
              }
              options={localizeOptions(FRACTIONS, t)}
              onChange={(v) =>
                sendPatch({ council: { approval: v === 'default' ? null : Number(v) } })
              }
              disabled={busy}
            />
            <PreferenceSelect
              label={t('settings:brain.councilPerSeatTimeoutLabel')}
              hint={t('settings:brain.councilPerSeatTimeoutHint')}
              value={optionalValue(config.council.perCallTimeoutMs)}
              options={localizeOptions(
                withCurrent(COUNCIL_CALL_TIMEOUTS, optionalValue(config.council.perCallTimeoutMs)),
                t,
              )}
              onChange={(v) =>
                sendPatch({ council: { perCallTimeoutMs: v === 'default' ? null : Number(v) } })
              }
              disabled={busy}
            />
            <PreferenceSelect
              label={t('settings:brain.councilMaxConcurrencyLabel')}
              hint={t('settings:brain.councilMaxConcurrencyHint')}
              value={optionalValue(config.council.maxConcurrency)}
              options={localizeOptions(
                withCurrent(COUNCIL_CONCURRENCY, optionalValue(config.council.maxConcurrency)),
                t,
              )}
              onChange={(v) =>
                sendPatch({ council: { maxConcurrency: v === 'default' ? null : Number(v) } })
              }
              disabled={busy}
            />
            <PreferenceSelect
              label={t('settings:brain.councilDistinctnessLabel')}
              hint={t('settings:brain.councilDistinctnessHint')}
              value={config.council.distinctness}
              options={[
                { value: 'none', label: t('settings:brain.optNoneDefault') },
                { value: 'model', label: t('settings:brain.optDistinctModels') },
                { value: 'provider', label: t('settings:brain.optDistinctProviders') },
              ]}
              onChange={(distinctness) => sendPatch({ council: { distinctness } })}
              disabled={busy}
            />
            <PreferenceSelect
              label={t('settings:brain.councilVoterBudgetLabel')}
              hint={t('settings:brain.councilVoterBudgetHint')}
              value={optionalValue(config.council.voterMaxTokens)}
              options={localizeOptions(
                withCurrent(VOTER_MAX_TOKENS, optionalValue(config.council.voterMaxTokens)),
                t,
              )}
              onChange={(v) =>
                sendPatch({ council: { voterMaxTokens: v === 'default' ? null : Number(v) } })
              }
              disabled={busy}
            />
            <PreferenceSelect
              label={t('settings:brain.councilRoundsLabel')}
              hint={t('settings:brain.councilRoundsHint')}
              value={optionalValue(config.council.deliberationRounds)}
              options={localizeOptions(
                withCurrent(DELIBERATION_ROUNDS, optionalValue(config.council.deliberationRounds)),
                t,
              )}
              onChange={(v) =>
                sendPatch({ council: { deliberationRounds: v === 'default' ? null : Number(v) } })
              }
              disabled={busy}
            />
            <PreferenceSelect
              label={t('settings:brain.councilJudgeBudgetLabel')}
              hint={t('settings:brain.councilJudgeBudgetHint')}
              value={optionalValue(config.council.judgeMaxTokens)}
              options={localizeOptions(
                withCurrent(JUDGE_MAX_TOKENS, optionalValue(config.council.judgeMaxTokens)),
                t,
              )}
              onChange={(v) =>
                sendPatch({ council: { judgeMaxTokens: v === 'default' ? null : Number(v) } })
              }
              disabled={busy}
            />
            {config.council.seats.length > 0 && (
              <p className="truncate text-xs text-muted-foreground">
                {t('settings:brain.councilSeatTemplate')}{' '}
                {config.council.seats
                  .map((seat) =>
                    seat.veto
                      ? `${seat.persona} (${t('settings:brain.councilVeto')})`
                      : seat.persona,
                  )
                  .join(', ')}
              </p>
            )}
          </div>

          {/* Ledger */}
          <div className="space-y-1 rounded-md border border-border/70 bg-muted/20 p-3">
            <span className="text-sm font-medium">{t('settings:brain.ledgerHeading')}</span>
            <PreferenceToggle
              label={t('settings:brain.ledgerRecordLabel')}
              hint={t('settings:brain.ledgerRecordHint')}
              value={config.ledger.enabled}
              onChange={() => sendPatch({ ledger: { enabled: !config.ledger.enabled } })}
              disabled={busy}
            />
            <PreferenceSelect
              label={t('settings:brain.ledgerAutoDenyLabel')}
              hint={t('settings:brain.ledgerAutoDenyHint')}
              value={
                config.ledger.autoDenyAfterFailures !== undefined
                  ? String(config.ledger.autoDenyAfterFailures)
                  : 'default'
              }
              options={[
                { value: 'default', label: t('settings:brain.optDefault3') },
                { value: '0', label: t('settings:brain.optOff') },
                { value: '2', label: '2' },
                { value: '3', label: '3' },
                { value: '5', label: '5' },
              ]}
              onChange={(v) =>
                sendPatch({
                  ledger: { autoDenyAfterFailures: v === 'default' ? null : Number(v) },
                })
              }
              disabled={busy}
            />
            <PreferenceSelect
              label={t('settings:brain.ledgerMemoryEntriesLabel')}
              hint={t('settings:brain.ledgerMemoryEntriesHint')}
              value={optionalValue(config.ledger.maxMemoryEntries)}
              options={localizeOptions(
                withCurrent(LEDGER_MEMORY_ENTRIES, optionalValue(config.ledger.maxMemoryEntries)),
                t,
              )}
              onChange={(v) =>
                sendPatch({ ledger: { maxMemoryEntries: v === 'default' ? null : Number(v) } })
              }
              disabled={busy}
            />
            <PreferenceSelect
              label={t('settings:brain.ledgerRetryWindowLabel')}
              hint={t('settings:brain.ledgerRetryWindowHint')}
              value={optionalValue(config.ledger.interventionRetryWindowMs)}
              options={localizeOptions(
                withCurrent(
                  INTERVENTION_WINDOWS,
                  optionalValue(config.ledger.interventionRetryWindowMs),
                ),
                t,
              )}
              onChange={(v) =>
                sendPatch({
                  ledger: { interventionRetryWindowMs: v === 'default' ? null : Number(v) },
                })
              }
              disabled={busy}
            />
            {config.ledger.path && (
              <p className="truncate text-xs text-muted-foreground">{config.ledger.path}</p>
            )}
          </div>
        </>
      )}

      {/* Recent decisions */}
      <div className="space-y-2 rounded-md border border-border/70 bg-card/70 p-3">
        <span className="text-sm font-medium">
          {t('settings:brain.recentHeading', { count: log.length })}
        </span>
        <div className="space-y-1 max-h-[300px] overflow-y-auto">
          {log.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">{t('settings:brain.recentEmpty')}</p>
          ) : (
            log.map((entry) => (
              <div
                key={`${entry.age}-${entry.kind}-${entry.question.slice(0, 32)}`}
                className="flex items-start gap-2 rounded-md border border-border/50 bg-background/40 px-2 py-1.5 text-xs"
              >
                <span className="text-muted-foreground shrink-0 w-8">{entry.age}</span>
                <Badge variant="outline" className="text-[10px] shrink-0">
                  {entry.kind}
                </Badge>
                <span className="flex-1 truncate">{entry.question}</span>
                {entry.outcome && (
                  <span className="text-muted-foreground shrink-0 italic">{entry.outcome}</span>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
