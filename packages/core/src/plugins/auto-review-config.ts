import type { ProviderModelStatusTracker } from '../coordination/provider-status-tracker.js';
import { FallbackProfileManager } from '../core/fallback-profile-manager.js';
import { parseModelRef } from '../core/model-ref.js';
import type { Config } from '../types/config.js';
import type { CascadeAgentKind } from './chimera-plugin.js';
import type { ChimeraFinding } from './review-finding-types.js';

export interface AutoReviewConfig {
  enabled?: boolean | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  fallbackProfile?: string | undefined;
  modelSelection?: 'round-robin' | 'random' | undefined;
  debounceMs?: number | undefined;
  maxFilesPerBatch?: number | undefined;
  maxConcurrentReviews?: number | undefined;
  cascadeOn?: 'off' | 'critical' | 'high' | undefined;
  maxCascadeDepth?: number | undefined;
}

export interface ResolvedAutoReviewConfig {
  enabled: boolean;
  provider: string;
  model: string;
  fallbackModels: string[];
  modelSelection: 'round-robin' | 'random';
  debounceMs: number;
  maxFilesPerBatch: number;
  maxConcurrentReviews: number;
  cascadeOn: 'off' | 'critical' | 'high';
  maxCascadeDepth: number;
}

export const DEFAULT_DEBOUNCE_MS = 15_000;
export const DEFAULT_MAX_FILES_PER_BATCH = 15;
export const DEFAULT_MAX_CONCURRENT_REVIEWS = 2;
export const DEFAULT_MAX_CASCADE_DEPTH = 2;

export const MAX_KNOWN_FINGERPRINTS = 5_000;

export function trimKnownFingerprints(map: Map<string, string>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

export interface ReviewerModelAssignment {
  provider: string;
  model: string;
  fallbackModels: string[];
  nextCursor: number;
}

export function buildReviewerModelPool(
  provider: string,
  model: string,
  fallbackModels: readonly string[] = [],
  statusTracker?: ProviderModelStatusTracker | undefined,
): string[] {
  const primaryProvider = provider.trim();
  const primaryModel = model.trim();
  const primaryRef = primaryProvider && primaryModel ? `${primaryProvider}/${primaryModel}` : '';
  const seen = new Set<string>();
  const pool: string[] = [];
  for (const raw of [primaryRef, ...fallbackModels]) {
    const ref = raw.trim();
    if (!ref || seen.has(ref)) continue;
    const parsed = parseModelRef(ref);
    if (!parsed.provider?.trim() || !parsed.model.trim()) continue;
    const normalized = `${parsed.provider.trim()}/${parsed.model.trim()}`;
    if (seen.has(normalized)) continue;
    seen.add(ref);
    seen.add(normalized);
    if (statusTracker && !statusTracker.isAvailable(parsed.provider!.trim(), parsed.model.trim())) {
      continue;
    }
    pool.push(normalized);
  }
  return pool;
}

export function selectRoundRobinReviewerAssignment(
  pool: readonly string[],
  cursor: number,
  fallbackProvider = '',
  fallbackModel = '',
  statusTracker?: ProviderModelStatusTracker | undefined,
): ReviewerModelAssignment {
  const filteredPool = statusTracker
    ? pool.filter((ref) => {
        const parsed = parseModelRef(ref);
        if (!parsed.provider?.trim() || !parsed.model.trim()) return false;
        return statusTracker.isAvailable(parsed.provider.trim(), parsed.model.trim());
      })
    : pool;
  if (filteredPool.length === 0) {
    return {
      provider: fallbackProvider,
      model: fallbackModel,
      fallbackModels: [],
      nextCursor: cursor + 1,
    };
  }
  const len = filteredPool.length;
  const idx = ((cursor % len) + len) % len;
  const primaryRef = filteredPool[idx]!;
  const parsed = parseModelRef(primaryRef);
  const provider = parsed.provider?.trim() || fallbackProvider;
  const model = parsed.model.trim() || fallbackModel;
  const fallbackModels = [...filteredPool.slice(idx + 1), ...filteredPool.slice(0, idx)];
  return {
    provider,
    model,
    fallbackModels,
    nextCursor: (idx + 1) % len,
  };
}

export function resolveAutoReviewConfig(
  cfg: AutoReviewConfig,
  sessionConfig: Config,
): ResolvedAutoReviewConfig {
  const mgr = new FallbackProfileManager(sessionConfig);
  const chain = mgr.resolveEffective({
    ...(cfg.fallbackProfile
      ? { fallbackProfile: cfg.fallbackProfile, fallbackAuto: false }
      : {
          fallbackModels: sessionConfig.fallbackModels,
          fallbackAuto: sessionConfig.fallbackAuto,
        }),
  });
  const rawProvider = cfg.provider?.trim();
  const rawModel = cfg.model?.trim();
  const resolvedProvider =
    rawProvider || (chain.length > 0 ? chain[0]!.providerId : sessionConfig.provider);
  const resolvedModel = rawModel || (chain.length > 0 ? chain[0]!.model : sessionConfig.model);
  const profileFallbackModels = chain
    .filter((entry) => entry.providerId !== resolvedProvider || entry.model !== resolvedModel)
    .map((entry) => `${entry.providerId}/${entry.model}`);

  const sessionRef = `${sessionConfig.provider}/${sessionConfig.model}`;
  const fallbackModels = [
    ...profileFallbackModels.filter((ref) => ref !== sessionRef),
    sessionRef,
  ].filter((ref) => ref !== `${resolvedProvider}/${resolvedModel}`);

  return {
    enabled: cfg.enabled === true,
    provider: resolvedProvider,
    model: resolvedModel,
    fallbackModels,
    modelSelection: cfg.modelSelection === 'random' ? 'random' : 'round-robin',
    debounceMs: cfg.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    maxFilesPerBatch: cfg.maxFilesPerBatch ?? DEFAULT_MAX_FILES_PER_BATCH,
    maxConcurrentReviews: cfg.maxConcurrentReviews ?? DEFAULT_MAX_CONCURRENT_REVIEWS,
    cascadeOn: cfg.cascadeOn ?? 'off',
    maxCascadeDepth: cfg.maxCascadeDepth ?? DEFAULT_MAX_CASCADE_DEPTH,
  };
}

export interface ParsedSeverities {
  critical: number;
  high: number;
  medium: number;
}

export function severitiesFromFindings(findings: readonly ChimeraFinding[]): ParsedSeverities {
  const severities: ParsedSeverities = { critical: 0, high: 0, medium: 0 };
  for (const finding of findings) {
    if (finding.severity === 'critical') severities.critical++;
    else if (finding.severity === 'high') severities.high++;
    else if (finding.severity === 'medium') severities.medium++;
  }
  return severities;
}

export function parseReviewSeverity(text: string): ParsedSeverities {
  const result: ParsedSeverities = { critical: 0, high: 0, medium: 0 };
  if (!text) return result;
  for (const level of ['critical', 'high', 'medium'] as const) {
    const countMatch = text.match(new RegExp(`###\\s*${level}\\s*\\((\\d+)\\)`, 'i'));
    if (countMatch?.[1]) {
      result[level] = Number.parseInt(countMatch[1], 10);
      continue;
    }
    const section = text.match(
      new RegExp(`###\\s*${level}[^\\n]*\\n([\\s\\S]*?)(?=###|$)`, 'i'),
    )?.[1];
    result[level] = section?.match(/^\s*\d+\.\s/gm)?.length ?? 0;
  }
  return result;
}

export function decideCascadeAgents(
  text: string,
  severities: ParsedSeverities,
  findings?: readonly ChimeraFinding[] | undefined,
): CascadeAgentKind[] {
  const agents = new Set<CascadeAgentKind>();
  if (severities.critical > 0 || severities.high > 0) agents.add('bug-hunter');

  if (findings && findings.length > 0) {
    const highPlus = findings.filter(
      (finding) => finding.severity === 'critical' || finding.severity === 'high',
    );
    if (highPlus.some((finding) => finding.category === 'security')) {
      agents.add('security-scanner');
    }
    if (highPlus.every((finding) => finding.category !== undefined)) {
      return [...agents];
    }
  }

  const securityKeywords = [
    'injection',
    'xss',
    'csrf',
    'ssrf',
    'sql',
    'secret',
    'credential',
    'password',
    'api key',
    'token',
    'auth',
    'shell injection',
    'command injection',
    'innerhtml',
    'deserialization',
    'path traversal',
    'hardcoded',
    'privilege',
    'owasp',
  ] as const;
  const criticalHighSections = text
    .toLowerCase()
    .matchAll(/###\s*(?:critical|high)[^\n]*\n([\s\S]*?)(?=###|$)/gi);
  for (const section of criticalHighSections) {
    const body = section[1] ?? '';
    if (securityKeywords.some((keyword) => body.includes(keyword))) {
      agents.add('security-scanner');
      break;
    }
  }
  return [...agents];
}

export function shouldCascade(
  cascadeOn: 'off' | 'critical' | 'high',
  severities: ParsedSeverities,
): 'high' | 'critical' | null {
  if (cascadeOn === 'off') return null;
  if (severities.critical > 0) return 'critical';
  if (cascadeOn === 'high' && severities.high > 0) return 'high';
  return null;
}
