import { displayLocale } from './display-dates';
import { entries, record } from './engine-values';

export const usageKinds = ['input', 'output', 'cache-read', 'cache-write'] as const;
export type UsageKind = (typeof usageKinds)[number];
export const usageLabels: Record<UsageKind, string> = {
  input: 'Fresh input',
  output: 'Output',
  'cache-read': 'Cache read',
  'cache-write': 'Cache write',
};
export interface PromptUsage {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  hitRatio?: number;
}
export interface UsageSnapshot {
  sessionId: string;
  provider: string;
  model: string;
  tokens: Record<UsageKind, number>;
  total: number;
  current: PromptUsage | null;
  last: PromptUsage | null;
  cache: {
    hitRatio: number | null;
    savedUsd: number | null;
    write5m: number | null;
    write1h: number | null;
    providers: Array<
      PromptUsage & { provider: string; write5m: number | null; write1h: number | null }
    >;
  };
  pricing: {
    coverage: string;
    estimateUsd: number | null;
    knownCostUsd: number | null;
    parts: Array<{
      kind: UsageKind;
      tokens: number;
      rateUsdPerMillion: number | null;
      rateSource: string;
      estimateUsd: number | null;
    }>;
  } | null;
  messages: number | null;
  readFiles: number | null;
  tools: number | null;
  sideEffects: number | null;
  elapsedMs: number | null;
}
const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const ratio = (value: unknown): number | null => {
  const n = finite(value);
  return n !== null && n <= 1 ? n : null;
};
function prompt(value: unknown): PromptUsage | null {
  const data = record(value),
    input = finite(data['input']),
    cacheRead = finite(data['cacheRead']),
    cacheWrite = finite(data['cacheWrite']);
  if (input === null || cacheRead === null || cacheWrite === null) return null;
  return {
    input,
    cacheRead,
    cacheWrite,
    ...(ratio(data['hitRatio']) !== null ? { hitRatio: ratio(data['hitRatio'])! } : {}),
  };
}
export function usageSnapshot(value: Record<string, unknown>, sessionId: string): UsageSnapshot {
  if (!sessionId || value['sessionId'] !== sessionId)
    throw Error('Usage response belongs to another conversation.');
  const usage = record(value['usage']),
    cache = record(value['cache']);
  const tokens = {
    input: finite(usage['input']),
    output: finite(usage['output']),
    'cache-read': finite(usage['cacheRead'] ?? cache['readTokens']),
    'cache-write': finite(usage['cacheWrite'] ?? cache['writeTokens']),
  };
  if (Object.values(tokens).some((token) => token === null))
    throw Error('This runtime returned incomplete usage counters.');
  let pricing: UsageSnapshot['pricing'] = null;
  if (value['pricing'] !== undefined) {
    const data = record(value['pricing']),
      parts = entries(data['parts']);
    const coverage = String(data['coverage']);
    if (
      data['currency'] !== 'USD' ||
      data['basis'] !== 'current-model-aggregate-rates' ||
      !['complete', 'partial', 'unavailable'].includes(coverage) ||
      parts.length !== 4 ||
      !Array.isArray(data['parts']) ||
      data['parts'].length !== 4 ||
      parts.some(
        (part, index) =>
          part['kind'] !== usageKinds[index] ||
          part['tokens'] !== tokens[usageKinds[index]!] ||
          (part['rateUsdPerMillion'] !== null && finite(part['rateUsdPerMillion']) === null) ||
          (part['estimateUsd'] !== null && finite(part['estimateUsd']) === null) ||
          !['catalog', 'input-fallback', 'unavailable'].includes(String(part['rateSource'])),
      )
    )
      throw Error('This runtime returned invalid pricing detail.');
    for (const key of ['estimateUsd', 'knownCostUsd'])
      if (data[key] !== null && finite(data[key]) === null)
        throw Error('This runtime returned an invalid estimate.');
    const close = (actual: unknown, expected: number | null) =>
      expected === null
        ? actual === null
        : typeof actual === 'number' &&
          Math.abs(actual - expected) <= 1e-10 * Math.max(1, expected);
    const known = parts.filter((part) => part['rateUsdPerMillion'] !== null).length;
    const knownCost = known
      ? parts.reduce((sum, part) => sum + (Number(part['estimateUsd']) || 0), 0)
      : null;
    const estimate =
      known && parts.every((part) => part['tokens'] === 0 || part['rateUsdPerMillion'] !== null)
        ? knownCost
        : null;
    if (
      coverage !== (known === 4 ? 'complete' : known ? 'partial' : 'unavailable') ||
      !close(data['knownCostUsd'], knownCost) ||
      !close(data['estimateUsd'], estimate) ||
      parts.some((part) =>
        part['rateUsdPerMillion'] === null
          ? part['rateSource'] !== 'unavailable' || part['estimateUsd'] !== null
          : part['rateSource'] === 'unavailable' ||
            !close(
              part['estimateUsd'],
              (Number(part['tokens']) * Number(part['rateUsdPerMillion'])) / 1_000_000,
            ),
      )
    )
      throw Error('Pricing detail is inconsistent with its known rates and usage.');
    pricing = {
      coverage,
      estimateUsd: data['estimateUsd'] as number | null,
      knownCostUsd: data['knownCostUsd'] as number | null,
      parts: parts as unknown as NonNullable<UsageSnapshot['pricing']>['parts'],
    };
  }
  return {
    sessionId,
    provider: String(value['provider'] ?? ''),
    model: String(value['model'] ?? ''),
    tokens: tokens as Record<UsageKind, number>,
    total: Object.values(tokens).reduce<number>((sum, n) => sum + (n ?? 0), 0),
    current: prompt(value['currentRequest']),
    last: prompt(cache['last']),
    cache: {
      hitRatio: ratio(cache['hitRatio']),
      savedUsd: finite(cache['savedUsd']),
      write5m: finite(cache['cacheWrite5m']),
      write1h: finite(cache['cacheWrite1h']),
      providers: entries(cache['providers']).flatMap((row) => {
        const p = prompt(row);
        return p && typeof row['provider'] === 'string'
          ? [
              {
                ...p,
                provider: row['provider'],
                write5m: finite(row['cacheWrite5m']),
                write1h: finite(row['cacheWrite1h']),
              },
            ]
          : [];
      }),
    },
    messages: finite(value['messages']),
    readFiles: finite(value['readFiles']),
    tools: finite(value['tools']),
    sideEffects: finite(value['sideEffectCount']),
    elapsedMs: finite(value['elapsedMs']),
    pricing,
  };
}
export const usageNumber = (value: number | null | undefined, missing = 'Not reported') =>
  value == null ? missing : value.toLocaleString(displayLocale());
export const usageMoney = (value: number | null | undefined, missing = 'Unavailable') =>
  value == null
    ? missing
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 4,
        maximumFractionDigits: 6,
      }).format(value);
export const usageRatio = (value: number | null | undefined, missing = 'Not reported') =>
  value == null
    ? missing
    : `${(value * 100).toLocaleString(displayLocale(), { maximumFractionDigits: 1 })}%`;
export function inlineUsageEstimate(
  stats: Record<string, unknown> | undefined,
): number | undefined {
  const pricing = record(stats?.['pricing']);
  const estimate = finite(pricing['estimateUsd']);
  if (estimate !== null && ['complete', 'partial'].includes(String(pricing['coverage'])))
    return estimate;
  const legacy = finite(stats?.['cost']);
  return stats?.['pricing'] === undefined && legacy !== null && legacy > 0 ? legacy : undefined;
}
