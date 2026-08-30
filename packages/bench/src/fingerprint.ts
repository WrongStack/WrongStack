import { createHash } from 'node:crypto';
import type { HarnessFingerprint } from './types.js';

export interface ToolManifestFingerprintInput {
  name: string;
  description?: string | undefined;
  usageHint?: string | undefined;
  inputSchema?: unknown;
  permission?: string | undefined;
  mutating?: boolean | undefined;
  category?: string | undefined;
  riskTier?: string | undefined;
}

/**
 * Compute the harness fingerprint. This is what makes a report
 * "model-independent": every cell in a run shares one fingerprint, so the only
 * thing that varies across leaderboard rows is the model. Change the CLI
 * version, the tool roster/manifest, the iteration cap, the yolo flag, the
 * prompt/config hash, or the task subset and the hash changes — which is
 * exactly when old numbers stop being comparable.
 *
 * The hash is intentionally cheap and reproducible: no timestamps, no random
 * salt. Same inputs → same hash, on any machine.
 */
export function computeHarnessFingerprint(input: {
  cliVersion: string;
  toolNames: string[];
  maxIterations: number;
  yolo: boolean;
  subsetId: string;
  toolManifestHash?: string | undefined;
  systemPromptHash?: string | undefined;
  configHash?: string | undefined;
}): HarnessFingerprint {
  const toolNames = [...input.toolNames].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // Canonical, order-stable serialization of every field that affects results.
  const canonical = JSON.stringify({
    cliVersion: input.cliVersion,
    toolNames,
    maxIterations: input.maxIterations,
    yolo: input.yolo,
    subsetId: input.subsetId,
    ...(input.toolManifestHash ? { toolManifestHash: input.toolManifestHash } : {}),
    ...(input.systemPromptHash ? { systemPromptHash: input.systemPromptHash } : {}),
    ...(input.configHash ? { configHash: input.configHash } : {}),
  });
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, 12);
  return {
    cliVersion: input.cliVersion,
    toolNames,
    maxIterations: input.maxIterations,
    yolo: input.yolo,
    subsetId: input.subsetId,
    ...(input.toolManifestHash ? { toolManifestHash: input.toolManifestHash } : {}),
    ...(input.systemPromptHash ? { systemPromptHash: input.systemPromptHash } : {}),
    ...(input.configHash ? { configHash: input.configHash } : {}),
    hash,
  };
}

/** One-line human label for report headers: `wrongstack@0.255 · fp:a3f9c7 · maxIter=40 · yolo`. */
export function fingerprintLabel(fp: HarnessFingerprint): string {
  const parts = [`wrongstack@${fp.cliVersion}`, `fp:${fp.hash}`, `maxIter=${fp.maxIterations}`];
  if (fp.yolo) parts.push('yolo');
  return parts.join(' · ');
}

/** Hash the tool manifest that the model can see and call. */
export function computeToolManifestHash(tools: ToolManifestFingerprintInput[]): string {
  const manifest = tools
    .map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
      usageHint: tool.usageHint ?? '',
      inputSchema: normalizeForHash(tool.inputSchema ?? null),
      permission: tool.permission ?? '',
      mutating: tool.mutating ?? false,
      category: tool.category ?? '',
      riskTier: tool.riskTier ?? '',
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return shortHash(stableStringify(manifest));
}

/** Hash arbitrary behavior-affecting text, such as a built system prompt. */
export function computeTextHash(text: string): string {
  return shortHash(text);
}

/** Hash arbitrary JSON-like config with stable key ordering. */
export function computeStableJsonHash(value: unknown): string {
  return shortHash(stableStringify(normalizeForHash(value)));
}

function shortHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForHash(value));
}

function normalizeForHash(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item) => normalizeForHash(item));
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record).sort((a, b) => a.localeCompare(b))) {
    out[key] = normalizeForHash(record[key]);
  }
  return out;
}
