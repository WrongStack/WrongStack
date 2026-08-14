/**
 * FallbackDoctor — diagnostic and simulation engine for WrongStack fallback systems.
 *
 * Provides deep inspection of active fallback configurations, diagnosing:
 * - Single-provider sibling quarantine risks (account-wide token/quota blocks)
 * - Context window bottlenecks (models too small for long sessions)
 * - Provider credential and configuration health
 * - Real-time quarantine / waiting room blocks
 * - Step-by-step failover simulation for hypothetical errors (429, quota, etc.)
 */

import type { ProviderModelStatusTracker } from '../coordination/provider-status-tracker.js';
import type { Config } from '../types/config.js';
import { isFallbackWorthy, type ProviderErrorKind } from '../types/provider.js';
import { FallbackProfileManager } from './fallback-profile-manager.js';
import { evaluateModelCalendar } from './model-availability-calendar.js';

export interface FallbackDiagnosticWarning {
  readonly code:
    | 'EMPTY_CHAIN'
    | 'SIBLING_QUARANTINE_RISK'
    | 'PROVIDER_UNUSABLE'
    | 'MODEL_QUARANTINED'
    | 'CALENDAR_BLOCKED'
    | 'CONTEXT_WINDOW_WARNING';
  readonly severity: 'warning' | 'critical' | 'info';
  readonly message: string;
  readonly target?: string | undefined;
  readonly recommendation?: string | undefined;
}

export interface FallbackDiagnosticReport {
  readonly primary: { readonly providerId: string; readonly model: string };
  readonly activeProfile: string | undefined;
  readonly explicitChain: readonly string[];
  readonly effectiveOrder: readonly string[];
  readonly autoEnabled: boolean;
  readonly status: 'healthy' | 'warning' | 'critical';
  readonly warnings: readonly FallbackDiagnosticWarning[];
  readonly crossProviderCount: number;
  readonly uniqueProviders: readonly string[];
}

export interface FallbackSimulationStep {
  readonly index: number;
  readonly providerId: string;
  readonly model: string;
  readonly skipped: boolean;
  readonly reason?: string | undefined;
  readonly providerSwitched: boolean;
}

export interface FallbackSimulationResult {
  readonly triggeringError: ProviderErrorKind;
  readonly isFallbackEligible: boolean;
  readonly primary: { readonly providerId: string; readonly model: string };
  readonly steps: readonly FallbackSimulationStep[];
  readonly finalTarget: { readonly providerId: string; readonly model: string } | null;
  readonly summary: string;
}

/**
 * Diagnose the active fallback configuration and chain for common failure modes.
 */
export function diagnoseFallbackConfig(
  config: Config,
  tracker?: ProviderModelStatusTracker | undefined,
  opts?: { modelContextLimitMap?: Record<string, number> | undefined } | undefined,
): FallbackDiagnosticReport {
  const mgr = new FallbackProfileManager(config, { statusTracker: tracker });
  const primary = { providerId: config.provider, model: config.model };
  const activeProfile = mgr.activeProfileName();
  const explicitChain = Object.freeze([...(config.fallbackModels ?? [])]);
  const effectiveCandidates = mgr.resolveCandidates(primary, {
    fallbackProfile: activeProfile,
  });
  const effectiveOrder = Object.freeze(
    effectiveCandidates.map((c) => `${c.providerId}/${c.model}`),
  );
  const autoEnabled = config.fallbackAuto !== false;

  const warnings: FallbackDiagnosticWarning[] = [];
  const providersInChain = new Set<string>();

  for (const entry of effectiveCandidates) {
    providersInChain.add(entry.providerId);
  }

  // 1. Check for empty chain
  if (effectiveCandidates.length === 0) {
    warnings.push({
      code: 'EMPTY_CHAIN',
      severity: 'critical',
      message:
        'The effective fallback chain is empty. Any rate limit or outage on the primary model will immediately fail without recovery.',
      recommendation:
        'Add fallback models using /fallback add <provider/model> or enable smart defaults with /fallback auto on.',
    });
  }

  // 2. Check for single-provider sibling quarantine risk
  if (effectiveCandidates.length > 0) {
    const onlyPrimaryProvider =
      providersInChain.size === 1 && providersInChain.has(primary.providerId);
    if (onlyPrimaryProvider) {
      warnings.push({
        code: 'SIBLING_QUARANTINE_RISK',
        severity: 'warning',
        message: `All fallback models belong to the same provider ("${primary.providerId}"). An account-level quota or token exhaustion will quarantine all sibling models at once.`,
        recommendation:
          'Add at least one cross-provider model (e.g. OpenAI, Anthropic, or Google) to your fallback profile.',
      });
    }
  }

  // 3. Check provider configuration usability for each candidate
  for (const entry of effectiveCandidates) {
    const health = mgr.checkProvider(entry.providerId);
    if (!health.usable) {
      warnings.push({
        code: 'PROVIDER_UNUSABLE',
        severity: 'critical',
        target: `${entry.providerId}/${entry.model}`,
        message: `Provider "${entry.providerId}" is missing an API key or baseUrl in configuration.`,
        recommendation: `Configure API credentials for "${entry.providerId}" or remove it from the fallback chain.`,
      });
    }

    // 4. Check active quarantine / status tracker
    if (tracker && !tracker.isAvailable(entry.providerId, entry.model)) {
      const status = tracker.getStatus(entry.providerId, entry.model);
      const remainingMs = status?.stateExpiresAt
        ? Math.max(0, status.stateExpiresAt - Date.now())
        : 0;
      const remainingSec = Math.round(remainingMs / 1000);
      warnings.push({
        code: 'MODEL_QUARANTINED',
        severity: 'warning',
        target: `${entry.providerId}/${entry.model}`,
        message: `Model is currently in quarantine (waiting room) due to ${status?.lastErrorKind ?? 'failures'}.${remainingSec > 0 ? ` Resets in ${remainingSec}s.` : ''}`,
        recommendation: 'Model will be automatically re-admitted once cooldown/reset expires.',
      });
    }

    // 5. Check model availability schedule
    const cal = evaluateModelCalendar(
      config.modelAvailabilitySchedule,
      entry.providerId,
      entry.model,
    );
    if (!cal.allowed) {
      warnings.push({
        code: 'CALENDAR_BLOCKED',
        severity: 'warning',
        target: `${entry.providerId}/${entry.model}`,
        message: `Model is blocked by the model availability calendar (${cal.rule?.label ?? 'schedule restriction'}).`,
      });
    }

    // 6. Check context window downgrade (e.g. 1M -> 200k or 200k -> 128k)
    if (opts?.modelContextLimitMap) {
      const primaryLimit =
        opts.modelContextLimitMap[`${primary.providerId}/${primary.model}`] ??
        opts.modelContextLimitMap[primary.model];
      const entryLimit =
        opts.modelContextLimitMap[`${entry.providerId}/${entry.model}`] ??
        opts.modelContextLimitMap[entry.model];

      if (
        typeof primaryLimit === 'number' &&
        typeof entryLimit === 'number' &&
        entryLimit > 0 &&
        primaryLimit > 0 &&
        entryLimit < primaryLimit
      ) {
        warnings.push({
          code: 'CONTEXT_WINDOW_WARNING',
          severity: 'warning',
          target: `${entry.providerId}/${entry.model}`,
          message: `Context window downgrade: primary model has ${primaryLimit.toLocaleString()} tokens capacity, but fallback candidate has only ${entryLimit.toLocaleString()} tokens. Long sessions will fail failover or require aggressive compaction.`,
          recommendation: `Ensure fallback models have equal or greater context capacity (>= ${primaryLimit.toLocaleString()} tokens) or keep sessions below ${entryLimit.toLocaleString()} tokens.`,
        });
      }
    }
  }

  const uniqueProviders = Object.freeze([...providersInChain]);
  const crossProviderCount = uniqueProviders.filter((p) => p !== primary.providerId).length;

  const hasCritical = warnings.some((w) => w.severity === 'critical');
  const hasWarning = warnings.some((w) => w.severity === 'warning');
  const status = hasCritical ? 'critical' : hasWarning ? 'warning' : 'healthy';

  return Object.freeze({
    primary: Object.freeze(primary),
    activeProfile,
    explicitChain,
    effectiveOrder,
    autoEnabled,
    status,
    warnings: Object.freeze(warnings),
    crossProviderCount,
    uniqueProviders,
  });
}

/**
 * Simulate a failover scenario for a given error kind and token level.
 */
export function simulateFallbackFailover(
  config: Config,
  opts: {
    errorKind?: ProviderErrorKind | undefined;
    currentTokens?: number | undefined;
    statusTracker?: ProviderModelStatusTracker | undefined;
    modelContextLimitMap?: Record<string, number> | undefined;
  } = {},
): FallbackSimulationResult {
  const errorKind = opts.errorKind ?? 'rate_limit';
  const isEligible = isFallbackWorthy(errorKind);
  const primary = { providerId: config.provider, model: config.model };

  if (!isEligible) {
    return Object.freeze({
      triggeringError: errorKind,
      isFallbackEligible: false,
      primary: Object.freeze(primary),
      steps: Object.freeze([]),
      finalTarget: null,
      summary: `Error kind "${errorKind}" is not fallback-worthy (request-shaped error, e.g. context_overflow/auth). The agent loop will not attempt fallback.`,
    });
  }

  const mgr = new FallbackProfileManager(config, { statusTracker: opts.statusTracker });
  const candidates = mgr.resolveCandidates(primary);
  const steps: FallbackSimulationStep[] = [];
  let finalTarget: { providerId: string; model: string } | null = null;

  for (let i = 0; i < candidates.length; i++) {
    const entry = candidates[i]!;
    const key = `${entry.providerId}/${entry.model}`;
    const providerSwitched = entry.providerId !== primary.providerId;

    // Check calendar
    const cal = evaluateModelCalendar(
      config.modelAvailabilitySchedule,
      entry.providerId,
      entry.model,
    );
    if (!cal.allowed) {
      steps.push({
        index: i + 1,
        providerId: entry.providerId,
        model: entry.model,
        skipped: true,
        reason: `Blocked by model availability calendar (${cal.rule?.label ?? 'schedule'})`,
        providerSwitched,
      });
      continue;
    }

    // Check tracker
    if (opts.statusTracker && !opts.statusTracker.isAvailable(entry.providerId, entry.model)) {
      steps.push({
        index: i + 1,
        providerId: entry.providerId,
        model: entry.model,
        skipped: true,
        reason: 'Quarantined in status tracker waiting room',
        providerSwitched,
      });
      continue;
    }

    // Check context window if limits provided and currentTokens specified
    const contextLimit = opts.modelContextLimitMap?.[key];
    if (
      typeof opts.currentTokens === 'number' &&
      opts.currentTokens > 0 &&
      typeof contextLimit === 'number' &&
      contextLimit > 0 &&
      opts.currentTokens > contextLimit
    ) {
      steps.push({
        index: i + 1,
        providerId: entry.providerId,
        model: entry.model,
        skipped: true,
        reason: `Context pre-filter: request tokens (${opts.currentTokens}) exceeds model window (${contextLimit})`,
        providerSwitched,
      });
      continue;
    }

    // Check provider config usability
    const health = mgr.checkProvider(entry.providerId);
    if (!health.usable) {
      steps.push({
        index: i + 1,
        providerId: entry.providerId,
        model: entry.model,
        skipped: true,
        reason: `Cannot construct provider "${entry.providerId}" (missing API key/endpoint)`,
        providerSwitched,
      });
      continue;
    }

    // Found working candidate
    steps.push({
      index: i + 1,
      providerId: entry.providerId,
      model: entry.model,
      skipped: false,
      providerSwitched,
    });
    finalTarget = { providerId: entry.providerId, model: entry.model };
    break;
  }

  const summary = finalTarget
    ? `Failover succeeded: will rotate from ${primary.providerId}/${primary.model} to ${finalTarget.providerId}/${finalTarget.model}.`
    : 'Failover failed: no usable fallback candidate could be reached.';

  return Object.freeze({
    triggeringError: errorKind,
    isFallbackEligible: true,
    primary: Object.freeze(primary),
    steps: Object.freeze(steps),
    finalTarget: finalTarget ? Object.freeze(finalTarget) : null,
    summary,
  });
}
