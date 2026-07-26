export interface CatalogProvider {
  id: string;
  name: string;
  family: string;
  apiBase?: string | undefined;
  envVars: string[];
  modelCount: number;
  hasApiKey: boolean;
}

export interface CatalogModel {
  id: string;
  name: string;
  releaseDate?: string | undefined;
  contextWindow?: number | undefined;
  inputCost?: number | undefined;
  outputCost?: number | undefined;
  capabilities: string[];
}

export interface ProbeResult {
  ok: boolean;
  status: string;
  httpStatus?: number | undefined;
  elapsedMs?: number | undefined;
  modelCount?: number | undefined;
  modelIds?: string[] | undefined;
  detail?: string | undefined;
}

export interface SavedProvider {
  id: string;
  family?: string | undefined;
  baseUrl?: string | undefined;
  /** Saved model allowlist (from server-side preset hydration). */
  models?: string[] | undefined;
  /** First entry of `models`, or undefined when the list is empty/unset. */
  pickedModelId?: string | undefined;
  apiKeys: Array<{
    label: string;
    maskedKey: string;
    isActive: boolean;
    createdAt: string;
  }>;
}

// ── Provider Key Card ────────────────────────────────────────────────────────
