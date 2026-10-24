import { join } from 'node:path';
import { type Container, type EventBus, TOKENS } from '@wrongstack/contracts/kernel';
import type { Config, Logger, Provider } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import {
  BrainDecisionLedger,
  BrainDecisionQueue,
  BrainMonitor,
  BrainTraceRecorder,
  EscalationRoutingBrainArbiter,
  getSharedProjectMailbox,
  mailboxSessionTag,
  ObservableBrainArbiter as ObservableBrainArbiterCtor,
  terminalPolicyDecision,
} from '@wrongstack/core/coordination';
import {
  type BrainAutoRisk,
  type BrainRuntimeOptions,
  createBrainRuntime,
  resolveBrainConfigDefaults,
} from '@wrongstack/core/execution';
import type { ProviderRegistry } from '@wrongstack/core/registry';
import { resolveTypeSafeJudge } from '@wrongstack/core/typesafe';
import type { WstackPaths } from '@wrongstack/core/utils';

/** Shared Brain ladder and standalone host-owned forms, monitor and persistence. */
export function createBackendBrain({
  config,
  getHostConfig,
  context,
  provider,
  providerRegistry,
  events,
  container,
  logger,
  wpaths,
  persistBrainConfig,
}: {
  config: Config;
  getHostConfig: () => Config;
  context: Context;
  provider: Provider;
  providerRegistry: ProviderRegistry;
  events: EventBus;
  container: Container;
  logger: Logger;
  wpaths: WstackPaths;
  persistBrainConfig: BrainRuntimeOptions['persist'];
}) {
  const brainCfg = resolveBrainConfigDefaults(config.brain, {
    fallbackModels: config.fallbackModels,
  });
  const brainLedgerPath = join(wpaths.projectDir, 'brain-ledger.jsonl');
  let brainLedgerEnabled = brainCfg.ledger?.enabled !== false;
  let brainLedger: BrainDecisionLedger | undefined;
  const startBrainLedger = (): void => {
    if (brainLedger) return;
    brainLedger = new BrainDecisionLedger({
      events,
      filePath: brainLedgerPath,
      maxMemoryEntries: brainCfg.ledger?.maxMemoryEntries,
      interventionRetryWindowMs: brainCfg.ledger?.interventionRetryWindowMs,
    });
    void brainLedger.start();
  };
  if (brainLedgerEnabled) startBrainLedger();
  let brainTrace: BrainTraceRecorder | undefined;
  const applyBrainTrace = (trace: NonNullable<Config['brain']>['trace']): void => {
    if (trace?.enabled !== true) {
      void brainTrace?.stop();
      brainTrace = undefined;
      return;
    }
    const settings = {
      filePath: trace.path ?? join(wpaths.projectDir, 'brain-trace.jsonl'),
      content: trace.content,
      maxOpenRecords: trace.maxOpenRecords,
    };
    if (brainTrace) brainTrace.reconfigure(settings);
    else {
      brainTrace = new BrainTraceRecorder({ events, ...settings });
      brainTrace.start();
    }
  };
  applyBrainTrace(brainCfg.trace);
  const brainQueueOptions = {
    timeoutMs: brainCfg.humanTimeoutMs,
    userInputAwaiter: context.userInputAwaiter,
    onTimeout: (request: Parameters<typeof terminalPolicyDecision>[0]) =>
      terminalPolicyDecision(request, brainRuntime.getSnapshot().terminalPolicy),
  };
  const brainQueue = new BrainDecisionQueue(events, brainQueueOptions);
  // Declared before the runtime so `onApplied` can re-tune it; assigned below,
  // once the Brain chain it consults exists.
  let brainMonitor: BrainMonitor | undefined;
  const brainRuntime = createBrainRuntime({
    initialConfig: brainCfg,
    defaultProviderId: config.provider,
    sessionProvider: () => provider,
    sessionModel: () => context.model,
    resolveProvider: (providerId) => {
      const savedCfg: Partial<import('@wrongstack/contracts/types').ProviderConfig> =
        config.providers?.[providerId] ?? {};
      // The legacy top-level key/baseUrl belong to the primary only (same rule
      // as the CLI's resolveRawProviderConnection). Handing them to every
      // provider sent the primary's key to other vendors, and to any base URL
      // `provider_manage` repointed (WS-2026-09-26-01).
      const isAccountAlias = savedCfg.type !== undefined && savedCfg.type !== providerId;
      const inheritsPrimary =
        !isAccountAlias && (config.provider === undefined || config.provider === providerId);
      // The VULN-006 sentinel (`endpointCredentialsSuppressed` in @wrongstack/providers).
      const repointed = Array.isArray(savedCfg.envVars) && savedCfg.envVars.length === 0;
      // `type` names the provider; the factory is the saved type (an alias
      // `work` is built by the `anthropic` factory, not looked up as `work`).
      return providerRegistry.create(
        {
          ...savedCfg,
          apiKey: savedCfg.apiKey ?? (inheritsPrimary && !repointed ? config.apiKey : undefined),
          baseUrl: savedCfg.baseUrl ?? (inheritsPrimary ? config.baseUrl : undefined),
          type: providerId,
        } as never,
        savedCfg.type ?? providerId,
      );
    },
    getSystemOneJudge: () =>
      resolveTypeSafeJudge({ config: getHostConfig(), feature: 'brain', logger }),
    ledger: {
      getPath: () => (brainLedgerEnabled ? brainLedgerPath : undefined),
      isEnabled: () => brainLedgerEnabled,
      setEnabled: (on) => {
        brainLedgerEnabled = on;
        if (on) {
          startBrainLedger();
        } else {
          void brainLedger?.stop();
          brainLedger = undefined;
        }
      },
      failureStreakFor: (request) => brainLedger?.failureStreakFor(request) ?? 0,
      getDecisionDigest: (request) => brainLedger?.digestFor(request),
    },
    persist: persistBrainConfig,
    // Keep the monitor's thresholds live, same as the CLI host. `reconfigure`
    // no-ops when the monitor block is unchanged, so unrelated Brain edits
    // (risk, pool, council) do not reset its in-flight failure streaks.
    onApplied: (snapshot) => {
      brainMonitor?.reconfigure(snapshot.monitor);
      brainQueueOptions.timeoutMs = snapshot.humanTimeoutMs;
      brainLedger?.reconfigure(snapshot.ledger);
      applyBrainTrace(brainRuntime.getConfig().trace);
      brainLog.splice(0, Math.max(0, brainLog.length - snapshot.decisionLogMaxEntries));
    },
  });
  // Back-compat facade for the risk-only route: assignment routes through
  // runtime.apply(), which live-applies AND persists.
  const brainSettings: { maxAutoRisk: BrainAutoRisk } = {
    get maxAutoRisk() {
      return brainRuntime.getMaxAutoRisk();
    },
    set maxAutoRisk(level: BrainAutoRisk) {
      void brainRuntime.apply({ maxAutoRisk: level }).persisted;
    },
  };
  const brain = new ObservableBrainArbiterCtor(
    new EscalationRoutingBrainArbiter(
      brainRuntime.arbiter,
      brainQueue,
      () => brainRuntime.getMode(),
      () => brainRuntime.getSnapshot().terminalPolicy,
      events,
    ),
    events,
  );
  container.bind(TOKENS.BrainArbiter, () => brain);

  // Decision log for the /brain command — last 20 decisions, newest last.
  // `sessionId` is carried so a tab can be shown ITS decisions: the Brain is
  // project-wide, but a decision is always about one session's tool call, and
  // an unlabelled mixture of four tabs' decisions answers nobody's question.
  const brainLog: Array<{
    at: number;
    kind: string;
    question: string;
    outcome: string;
    sessionId?: string | undefined;
    tier?: string | undefined;
  }> = [];
  const pushBrainLog = (entry: (typeof brainLog)[number]) => {
    brainLog.push(entry);
    if (brainLog.length > brainRuntime.getSnapshot().decisionLogMaxEntries) brainLog.shift();
  };
  const brainLogOffs = [
    events.on('brain.decision_answered', (e) =>
      pushBrainLog({
        at: e.at,
        sessionId: e.sessionId,
        kind: 'answered',
        tier: e.tier,
        question: e.request.question,
        outcome: e.decision.type === 'answer' ? (e.decision.optionId ?? e.decision.text) : '',
      }),
    ),
    events.on('brain.decision_ask_human', (e) =>
      pushBrainLog({
        at: e.at,
        sessionId: e.sessionId,
        kind: 'ask_human',
        question: e.request.question,
        outcome: 'needs human judgement',
      }),
    ),
    events.on('brain.decision_denied', (e) =>
      pushBrainLog({
        at: e.at,
        sessionId: e.sessionId,
        kind: 'denied',
        tier: e.tier,
        question: e.request.question,
        outcome: e.decision.type === 'deny' ? e.decision.reason : '',
      }),
    ),
  ];

  // Self-activation: watch for tool-failure streaks / error storms. Only
  // events with an originating session can steer a WebUI leader.
  const brainMailbox = getSharedProjectMailbox(wpaths.projectDir, events);
  brainMonitor = new BrainMonitor({
    events,
    brain,
    // The full `config.brain.monitor` surface, matching the CLI host. Boot used
    // to skip enabled/policy/signals/errorStormWindowMs/stallCheckIntervalMs/
    // fileEditTools, so those settings were inert here — and now that
    // `reconfigure()` applies the whole block, an unrelated Brain edit would
    // have been the first thing to honour them.
    enabled: brainCfg.monitor?.enabled,
    policy: brainCfg.monitor?.policy,
    signals: brainCfg.monitor?.signals,
    toolFailureStreak: brainCfg.monitor?.toolFailureStreak,
    errorStormCount: brainCfg.monitor?.errorStormCount,
    errorStormWindowMs: brainCfg.monitor?.errorStormWindowMs,
    stallMs: brainCfg.monitor?.stallMs,
    stallCheckIntervalMs: brainCfg.monitor?.stallCheckIntervalMs,
    fileChurnThreshold: brainCfg.monitor?.fileChurnThreshold,
    fileChurnWindowMs: brainCfg.monitor?.fileChurnWindowMs,
    fileEditTools: brainCfg.monitor?.fileEditTools,
    cooldownMs: brainCfg.monitor?.cooldownMs,
    // Never infer an owner from the foreground tab: WebUI events must carry
    // their originating session, even if that tab is now in the background.
    intervene: async ({ subject, body, sessionId }) => {
      if (!sessionId) return;
      const tag = mailboxSessionTag(sessionId);
      await brainMailbox.send({
        from: `brain@${tag}`,
        to: `leader@${tag}`,
        type: 'steer',
        subject,
        body,
        priority: 'high',
      });
    },
  });
  brainMonitor.start();
  console.log('[WebUI] Brain initialized (tiered policy → LLM, monitor active)');

  return {
    brain,
    brainSettings,
    brainRuntime,
    brainLog,
    brainMonitor,
    get brainLedger() {
      return brainLedger;
    },
    dispose() {
      brainMonitor.stop();
      brainQueue.dispose();
      brainRuntime.dispose();
      void brainLedger?.stop();
      void brainTrace?.stop();
      for (const off of brainLogOffs) off();
    },
  };
}
