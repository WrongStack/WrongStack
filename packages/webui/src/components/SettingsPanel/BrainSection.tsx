import { ArrowDown, ArrowUp, Brain, Loader2, Plus, X } from 'lucide-react';
import { type ReactElement, useCallback, useEffect, useMemo, useState } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';
import type {
  BrainConfigPatchWire,
  BrainConfigWire,
  BrainCouncilVoterWire,
  WSServerMessage,
} from '@/types';
import { cn } from '@/lib/utils';
import { ModelSelectDialog } from '../ModelSelectDialog';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { PreferenceSelect } from './PreferenceControls';
import { PreferenceToggle } from './PreferenceToggle';

import {
  CACHE_MAX_ENTRIES,
  CACHE_TTLS,
  COUNCIL_CALL_TIMEOUTS,
  COUNCIL_CONCURRENCY,
  DECISION_LOG_SIZES,
  DECISION_TIMEOUTS,
  FRACTIONS,
  HUMAN_TIMEOUTS,
  INTERVENTION_WINDOWS,
  JUDGE_MAX_TOKENS,
  LEDGER_MEMORY_ENTRIES,
  LLM_MAX_TOKENS,
  MIN_CONFIDENCE,
  PICK_TITLES,
  RISK_COPY,
  RISK_LEVELS,
  RiskDot,
  councilPersonaOptions,
  entryLabel,
  optionalValue,
  withCurrent,
  type PickTarget,
  type RiskLevel,
} from './brain-section-options';
export function BrainSection(): ReactElement {
  const { client } = useWebSocket();
  const [config, setConfig] = useState<BrainConfigWire | null>(null);
  const [log, setLog] = useState<
    Array<{ kind: string; question: string; outcome: string; age: string }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [persistError, setPersistError] = useState<string | null>(null);
  const [pickTarget, setPickTarget] = useState<PickTarget>(null);

  // Fetch brain status + editable config on mount
  useEffect(() => {
    client.send({ type: 'brain.status' });
    client.send({ type: 'brain.config.get' });
  }, [client]);

  // Listen for brain status/config responses
  useEffect(() => {
    const offStatus = client.on('brain.status', (msg: WSServerMessage) => {
      const p = msg.payload as {
        maxAutoRisk: string;
        log: Array<{ at: number; kind: string; question: string; outcome: string }>;
      };
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
      setPersistError(p.persisted ? null : (p.error ?? 'Settings applied live but not saved.'));
      setBusy(false);
      setLoading(false);
    });
    return () => {
      offStatus();
      offConfig();
    };
  }, [client]);

  /** Every control funnels here: live-apply + persist on the server, reconcile on reply. */
  const sendPatch = useCallback(
    (patch: BrainConfigPatchWire) => {
      setBusy(true);
      client.send({ type: 'brain.config.set', payload: { patch } });
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

  const voters: BrainCouncilVoterWire[] = useMemo(
    () => config?.council.voters ?? [],
    [config],
  );

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
        title={pickTarget ? PICK_TITLES[pickTarget].title : ''}
        hint={pickTarget ? PICK_TITLES[pickTarget].hint : undefined}
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
          <h3 className="text-base font-semibold">Brain</h3>
          <p className="text-xs text-muted-foreground">
            Decision models, council, escalation and risk ceiling — applied live, saved to the
            global config.
          </p>
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
        <span className="text-sm font-medium">Autonomy ceiling</span>
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
        <p className="text-xs text-muted-foreground">{RISK_COPY[riskLevel]}</p>
      </div>

      {config && (
        <>
          {/* Escalation */}
          <div className="space-y-1 rounded-md border border-border/70 bg-muted/20 p-3">
            <span className="text-sm font-medium">Escalation</span>
            <PreferenceSelect
              label="Mode"
              hint="Headless: the Brain never blocks on a human — unanswered escalations resolve via the safe terminal policy. Applies to CLI/TUI sessions; the standalone WebUI Brain is always headless."
              value={config.mode}
              options={[
                { value: 'interactive', label: 'Interactive (ask me)' },
                { value: 'headless', label: 'Headless (never ask)' },
              ]}
              onChange={(mode) => sendPatch({ mode })}
              disabled={busy}
            />
            <PreferenceSelect
              label="Decision timeout"
              hint="Per-LLM-call time budget for one Brain decision."
              value={config.decisionTimeoutMs ? String(config.decisionTimeoutMs) : 'default'}
              options={DECISION_TIMEOUTS}
              onChange={(v) =>
                sendPatch({ decisionTimeoutMs: v === 'default' ? null : Number(v) })
              }
              disabled={busy}
            />
            <PreferenceSelect
              label="Human answer timeout"
              hint="Interactive mode: how long an escalation prompt may wait before the terminal policy resolves it."
              value={config.humanTimeoutMs ? String(config.humanTimeoutMs) : 'off'}
              options={HUMAN_TIMEOUTS}
              onChange={(v) => sendPatch({ humanTimeoutMs: v === 'off' ? null : Number(v) })}
              disabled={busy}
            />
            <PreferenceSelect
              label="Terminal policy"
              hint="How a headless escalation resolves with no human available. Conservative accepts a recommended option at low/medium risk; deny-all never auto-accepts; continue-on-recommended accepts a recommended option at ANY risk."
              value={config.terminalPolicy}
              options={[
                { value: 'conservative', label: 'Conservative (default)' },
                { value: 'deny-all', label: 'Deny all' },
                { value: 'continue-on-recommended', label: 'Continue on recommended' },
              ]}
              onChange={(terminalPolicy) => sendPatch({ terminalPolicy })}
              disabled={busy}
            />
            <PreferenceSelect
              label="Decision log size"
              hint="Rolling in-memory decision log kept for the status view."
              value={String(config.decisionLogMaxEntries)}
              options={withCurrent(DECISION_LOG_SIZES, String(config.decisionLogMaxEntries))}
              onChange={(v) => sendPatch({ decisionLogMaxEntries: Number(v) })}
              disabled={busy}
            />
          </div>

          {/* Deterministic rules (read-only) */}
          <div className="space-y-1 rounded-md border border-border/70 bg-muted/20 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Deterministic rules</span>
              <Badge variant="outline" className="text-[10px]">
                {config.rules.length} configured
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Evaluated before any provider call — first match wins. Edit them in the global config
              file; this view is read-only.
            </p>
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
                        off
                      </Badge>
                    )}
                  </div>
                ))}
              </div>
            )}
            {config.ruleErrors.length > 0 && (
              <div className="space-y-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5">
                <span className="text-xs font-medium text-warning">
                  {config.ruleErrors.length} rule(s) dropped
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
            <span className="text-sm font-medium">Heuristics</span>
            <p className="text-xs text-muted-foreground">
              Free pattern guesses that settle a question before any model runs. All on by default —
              turn one off when its guess is wrong for your workload.
            </p>
            <PreferenceToggle
              label="Low-risk auto-answer"
              hint="Auto-answer low-risk requests that already carry a recommended option."
              value={config.heuristics.lowRiskAutoAnswer}
              onChange={() =>
                sendPatch({
                  heuristics: { lowRiskAutoAnswer: !config.heuristics.lowRiskAutoAnswer },
                })
              }
              disabled={busy}
            />
            <PreferenceToggle
              label="Blocked-resolved"
              hint="'blocked …' plus an explicit resolution marker in the context resolves to continue."
              value={config.heuristics.blockedResolved}
              onChange={() =>
                sendPatch({ heuristics: { blockedResolved: !config.heuristics.blockedResolved } })
              }
              disabled={busy}
            />
            <PreferenceToggle
              label="Deadlock skip"
              hint="'deadlock' plus failed work units in the context resolves to skip and continue."
              value={config.heuristics.deadlockSkip}
              onChange={() =>
                sendPatch({ heuristics: { deadlockSkip: !config.heuristics.deadlockSkip } })
              }
              disabled={busy}
            />
            <PreferenceToggle
              label="Retry exhausted"
              hint="'failed'/'retry' plus demonstrably exhausted retries marks the unit failed and moves on."
              value={config.heuristics.retryExhausted}
              onChange={() =>
                sendPatch({ heuristics: { retryExhausted: !config.heuristics.retryExhausted } })
              }
              disabled={busy}
            />
            <PreferenceToggle
              label="Continue ping"
              hint="A bare continue/proceed ping with no competing alternative resolves to continue."
              value={config.heuristics.continuePing}
              onChange={() =>
                sendPatch({ heuristics: { continuePing: !config.heuristics.continuePing } })
              }
              disabled={busy}
            />
            {config.heuristics.blockedResolvedMarkers &&
              config.heuristics.blockedResolvedMarkers.length > 0 && (
                <p className="truncate text-xs text-muted-foreground">
                  Markers: {config.heuristics.blockedResolvedMarkers.join(', ')}
                </p>
              )}
          </div>

          {/* LLM quality gate */}
          <div className="space-y-1 rounded-md border border-border/70 bg-muted/20 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">LLM quality</span>
              {config.circuit && (
                <Badge
                  variant={config.circuit.state === 'closed' ? 'outline' : 'default'}
                  className="text-[10px]"
                >
                  circuit {config.circuit.state} · {config.circuit.consecutiveFailures} fail
                </Badge>
              )}
            </div>
            <PreferenceSelect
              label="Response budget"
              hint="Output tokens per decision call. A Brain response is one decision plus a one-sentence rationale."
              value={String(config.llm.maxTokens)}
              options={withCurrent(LLM_MAX_TOKENS, String(config.llm.maxTokens))}
              onChange={(v) => sendPatch({ llm: { maxTokens: Number(v) } })}
              disabled={busy}
            />
            <PreferenceToggle
              label="Reject uncertain answers"
              hint="Treat a declined or empty response as 'this tier could not decide' instead of accepting it as an answer."
              value={config.llm.rejectUncertain}
              onChange={() => sendPatch({ llm: { rejectUncertain: !config.llm.rejectUncertain } })}
              disabled={busy}
            />
            <PreferenceSelect
              label="Minimum confidence"
              hint="Reject answers whose self-reported confidence is below this. Responses reporting no confidence always pass."
              value={String(config.llm.minConfidence)}
              options={withCurrent(MIN_CONFIDENCE, String(config.llm.minConfidence))}
              onChange={(v) => sendPatch({ llm: { minConfidence: Number(v) } })}
              disabled={busy}
            />
            <PreferenceSelect
              label="Deny is terminal"
              hint="Whether a deny from the single-LLM tier ends the decision. 'when-decided' makes a genuine refusal terminal while infrastructure failures still escalate."
              value={config.llm.denyIsTerminal}
              options={[
                { value: 'never', label: 'Never (default)' },
                { value: 'when-decided', label: 'When decided' },
                { value: 'always', label: 'Always' },
              ]}
              onChange={(denyIsTerminal) => sendPatch({ llm: { denyIsTerminal } })}
              disabled={busy}
            />
          </div>

          {/* Replay trace */}
          <div className="space-y-1 rounded-md border border-border/70 bg-muted/20 p-3">
            <span className="text-sm font-medium">Replay trace</span>
            <PreferenceToggle
              label="Record decision traces"
              hint="Per-decision JSONL of every tier, pool target and council vote, with timings and token usage. Off by default — enabling it writes decision content to disk."
              value={config.trace.enabled}
              onChange={() => sendPatch({ trace: { enabled: !config.trace.enabled } })}
              disabled={busy}
            />
            <PreferenceSelect
              label="Trace content"
              hint="'full' keeps question and context (needed to replay a decision); 'redacted' truncates free text; 'none' records metadata only."
              value={config.trace.content}
              options={[
                { value: 'full', label: 'Full (default)' },
                { value: 'redacted', label: 'Redacted' },
                { value: 'none', label: 'Metadata only' },
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
              <span className="text-sm font-medium">Decision cache</span>
              <Badge variant="outline" className="text-[10px]">
                {config.cache.hits} hit / {config.cache.misses} miss · {config.cache.size} live
              </Badge>
            </div>
            <PreferenceToggle
              label="Replay identical verdicts"
              hint="Reuse a previous council/LLM verdict for an identical repeated question. Deterministic tiers and ask-human are never cached; a decision the ledger observes to have failed is evicted."
              value={config.cache.enabled}
              onChange={() => sendPatch({ cache: { enabled: !config.cache.enabled } })}
              disabled={busy}
            />
            <PreferenceSelect
              label="Entry lifetime"
              hint="How long a cached verdict stays replayable."
              value={String(config.cache.ttlMs)}
              options={withCurrent(CACHE_TTLS, String(config.cache.ttlMs))}
              onChange={(v) => sendPatch({ cache: { ttlMs: Number(v) } })}
              disabled={busy}
            />
            <PreferenceSelect
              label="Maximum entries"
              hint="Cap on live cached verdicts."
              value={String(config.cache.maxEntries)}
              options={withCurrent(CACHE_MAX_ENTRIES, String(config.cache.maxEntries))}
              onChange={(v) => sendPatch({ cache: { maxEntries: Number(v) } })}
              disabled={busy}
            />
          </div>

          {/* Monitor */}
          <div className="space-y-1 rounded-md border border-border/70 bg-muted/20 p-3">
            <span className="text-sm font-medium">Monitor</span>
            <p className="text-xs text-muted-foreground">
              Distress-signal self-activation. The monitor is built once at boot, so these apply to
              the next session rather than live.
            </p>
            <PreferenceToggle
              label="Watch for distress signals"
              hint="Tool-failure streaks, error storms, agent stalls and file churn engage the Brain on their own."
              value={config.monitor.enabled !== false}
              onChange={() =>
                sendPatch({ monitor: { enabled: config.monitor.enabled === false } })
              }
              disabled={busy}
            />
            <PreferenceSelect
              label="Signal policy"
              hint="How a detected signal resolves. 'llm' consults the Brain; 'steer' always intervenes and 'observe' never does — both without a provider call."
              value={config.monitor.policy ?? 'llm'}
              options={[
                { value: 'llm', label: 'Consult the Brain (default)' },
                { value: 'steer', label: 'Always steer' },
                { value: 'observe', label: 'Observe only' },
              ]}
              onChange={(policy) => sendPatch({ monitor: { policy } })}
              disabled={busy}
            />
          </div>

          {/* Decision models */}
          <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Decision models</span>
              <Badge variant="outline" className="text-[10px]">
                {config.usingSessionModel
                  ? 'session model'
                  : `${config.poolLabels.length}/${config.models.length} resolved`}
              </Badge>
            </div>
            <PreferenceToggle
              label="Use session model"
              hint="Decide with whatever model the session is running. Turn off by adding models below."
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
              <Plus className="h-3.5 w-3.5" /> Add model
            </Button>
            {config.models.length > 1 && (
              <PreferenceSelect
                label="Pool strategy"
                hint="Fallback: first model is primary, the rest are tried in order on failure. Round-robin: decisions rotate across the pool."
                value={config.strategy}
                options={[
                  { value: 'fallback', label: 'Fallback' },
                  { value: 'round-robin', label: 'Round-robin' },
                ]}
                onChange={(strategy) => sendPatch({ strategy })}
                disabled={busy}
              />
            )}
          </div>

          {/* Council */}
          <div className="space-y-2 rounded-md border border-border/70 bg-muted/20 p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Council</span>
              <Badge variant={config.council.enabled ? 'default' : 'outline'} className="text-[10px]">
                {config.council.enabled ? 'convened' : 'disabled'}
              </Badge>
            </div>
            <PreferenceToggle
              label="Enable multi-LLM council"
              hint="High-stakes questions are voted on by independent seats (executor / skeptic-with-veto / auditor) instead of one model. Needs ≥2 resolvable voters (explicit seats below, or a ≥2-model pool)."
              value={config.council.enabled}
              onChange={() => sendPatch({ council: { enabled: !config.council.enabled } })}
              disabled={busy}
            />
            {config.council.enabled && config.councilLabels.length > 0 && voters.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Seats derived from the pool: {config.councilLabels.join(', ')}
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
                        'Custom decision lens — sent to the seat verbatim.'
                      }
                    >
                      {personaOptions.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                      {voter.persona && !personaOptions.some((p) => p.id === voter.persona) && (
                        <option value={voter.persona}>{voter.persona} (custom)</option>
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
                      veto
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
              <Plus className="h-3.5 w-3.5" /> Add voter
            </Button>
            <PreferenceSelect
              label="Risk floor"
              hint="Minimum question risk that convenes the council instead of the single-model tier."
              value={config.council.minRisk}
              options={[
                { value: 'medium', label: 'Medium+' },
                { value: 'high', label: 'High+' },
                { value: 'critical', label: 'Critical only' },
              ]}
              onChange={(minRisk) => sendPatch({ council: { minRisk } })}
              disabled={busy}
            />
            <div className="flex items-start justify-between gap-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">Judge</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  Tie-breaker model that sees every vote's rationale.
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
                    resolved: {config.judgeLabel}
                    {config.judgeIsVoter && (
                      <span className="ml-1 font-sans text-warning">⚠ also a voter</span>
                    )}
                  </div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <span className="max-w-[180px] truncate font-mono text-xs">
                  {config.council.judge ? entryLabel(config.council.judge) : 'auto'}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 text-xs"
                  disabled={busy}
                  onClick={() => setPickTarget('judge')}
                >
                  Pick…
                </Button>
                {config.council.judge && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    disabled={busy}
                    onClick={() => sendPatch({ council: { judge: null } })}
                  >
                    Auto
                  </Button>
                )}
              </div>
            </div>
            <PreferenceSelect
              label="Quorum"
              hint="Fraction of seats that must return a valid vote."
              value={config.council.quorum !== undefined ? String(config.council.quorum) : 'default'}
              options={FRACTIONS}
              onChange={(v) => sendPatch({ council: { quorum: v === 'default' ? null : Number(v) } })}
              disabled={busy}
            />
            <PreferenceSelect
              label="Approval"
              hint="Fraction of cast vote weight the winning option must exceed."
              value={
                config.council.approval !== undefined ? String(config.council.approval) : 'default'
              }
              options={FRACTIONS}
              onChange={(v) =>
                sendPatch({ council: { approval: v === 'default' ? null : Number(v) } })
              }
              disabled={busy}
            />
            <PreferenceSelect
              label="Per-seat timeout"
              hint="Time budget for a single seat's vote. Slower than the decision timeout means one stalled seat holds up the vote."
              value={optionalValue(config.council.perCallTimeoutMs)}
              options={withCurrent(
                COUNCIL_CALL_TIMEOUTS,
                optionalValue(config.council.perCallTimeoutMs),
              )}
              onChange={(v) =>
                sendPatch({ council: { perCallTimeoutMs: v === 'default' ? null : Number(v) } })
              }
              disabled={busy}
            />
            <PreferenceSelect
              label="Max concurrency"
              hint="How many seats vote in parallel. Lower this when the pool shares one rate-limited provider."
              value={optionalValue(config.council.maxConcurrency)}
              options={withCurrent(
                COUNCIL_CONCURRENCY,
                optionalValue(config.council.maxConcurrency),
              )}
              onChange={(v) =>
                sendPatch({ council: { maxConcurrency: v === 'default' ? null : Number(v) } })
              }
              disabled={busy}
            />
            <PreferenceSelect
              label="Seat distinctness"
              hint="Reject duplicate seats: 'model' requires distinct models, 'provider' requires independent providers so one outage cannot sway the vote."
              value={config.council.distinctness}
              options={[
                { value: 'none', label: 'None (default)' },
                { value: 'model', label: 'Distinct models' },
                { value: 'provider', label: 'Distinct providers' },
              ]}
              onChange={(distinctness) => sendPatch({ council: { distinctness } })}
              disabled={busy}
            />
            <PreferenceSelect
              label="Judge response budget"
              hint="Output tokens for the tie-breaking judge call."
              value={optionalValue(config.council.judgeMaxTokens)}
              options={withCurrent(JUDGE_MAX_TOKENS, optionalValue(config.council.judgeMaxTokens))}
              onChange={(v) =>
                sendPatch({ council: { judgeMaxTokens: v === 'default' ? null : Number(v) } })
              }
              disabled={busy}
            />
            {config.council.seats.length > 0 && (
              <p className="truncate text-xs text-muted-foreground">
                Seat template:{' '}
                {config.council.seats
                  .map((seat) => (seat.veto ? `${seat.persona} (veto)` : seat.persona))
                  .join(', ')}
              </p>
            )}
          </div>

          {/* Ledger */}
          <div className="space-y-1 rounded-md border border-border/70 bg-muted/20 p-3">
            <span className="text-sm font-medium">Decision ledger</span>
            <PreferenceToggle
              label="Record decisions + outcomes"
              hint="Persists every decision and its observed outcome; similar past outcomes are fed back into future Brain prompts."
              value={config.ledger.enabled}
              onChange={() => sendPatch({ ledger: { enabled: !config.ledger.enabled } })}
              disabled={busy}
            />
            <PreferenceSelect
              label="Auto-deny after failures"
              hint="Deny deterministically (no LLM) once this many consecutive approvals of a decision group ended in observed failures."
              value={
                config.ledger.autoDenyAfterFailures !== undefined
                  ? String(config.ledger.autoDenyAfterFailures)
                  : 'default'
              }
              options={[
                { value: 'default', label: 'Default (3)' },
                { value: '0', label: 'Off' },
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
              label="In-memory entries"
              hint="Ring size held in memory, and the number of past entries seeded from disk at boot."
              value={optionalValue(config.ledger.maxMemoryEntries)}
              options={withCurrent(
                LEDGER_MEMORY_ENTRIES,
                optionalValue(config.ledger.maxMemoryEntries),
              )}
              onChange={(v) =>
                sendPatch({ ledger: { maxMemoryEntries: v === 'default' ? null : Number(v) } })
              }
              disabled={busy}
            />
            <PreferenceSelect
              label="Intervention retry window"
              hint="A same-kind monitor intervention re-firing inside this window marks the previous steer as a failure."
              value={optionalValue(config.ledger.interventionRetryWindowMs)}
              options={withCurrent(
                INTERVENTION_WINDOWS,
                optionalValue(config.ledger.interventionRetryWindowMs),
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
        <span className="text-sm font-medium">Recent decisions ({log.length})</span>
        <div className="space-y-1 max-h-[300px] overflow-y-auto">
          {log.length === 0 ? (
            <p className="text-xs text-muted-foreground py-2">
              No decisions recorded yet this session.
            </p>
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
