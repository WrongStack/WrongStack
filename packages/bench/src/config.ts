import * as fs from 'node:fs/promises';
import type { BenchConfig, ModelCell } from './types.js';

const DEFAULTS = {
  maxIterations: 40,
  concurrency: 4,
  timeoutMs: 600_000,
  repeats: 1,
} as const;

/**
 * Parse and validate a raw `bench.config.json` object. Throws a descriptive
 * Error on any structural problem so the CLI can surface it cleanly instead of
 * failing deep inside the runner.
 */
export function parseBenchConfig(raw: unknown): BenchConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('bench config must be a JSON object');
  }
  const obj = raw as Record<string, unknown>;

  const cellsRaw = obj['cells'];
  if (!Array.isArray(cellsRaw) || cellsRaw.length === 0) {
    throw new Error('bench config "cells" must be a non-empty array');
  }

  const seen = new Set<string>();
  const cells: ModelCell[] = cellsRaw.map((c, i) => {
    if (typeof c !== 'object' || c === null) {
      throw new Error(`cells[${i}] must be an object`);
    }
    const cell = c as Record<string, unknown>;
    const provider = cell['provider'];
    const model = cell['model'];
    if (typeof provider !== 'string' || provider.length === 0) {
      throw new Error(`cells[${i}].provider must be a non-empty string`);
    }
    if (typeof model !== 'string' || model.length === 0) {
      throw new Error(`cells[${i}].model must be a non-empty string`);
    }
    const label =
      typeof cell['label'] === 'string' && cell['label'].length > 0
        ? cell['label']
        : `${provider}/${model}`;
    if (seen.has(label)) {
      throw new Error(`duplicate cell label "${label}" — labels must be unique`);
    }
    seen.add(label);
    return { label, provider, model };
  });

  const maxIterations = positiveInt(obj['maxIterations'], DEFAULTS.maxIterations, 'maxIterations');
  const concurrency = positiveInt(obj['concurrency'], DEFAULTS.concurrency, 'concurrency');
  const timeoutMs = positiveInt(obj['timeoutMs'], DEFAULTS.timeoutMs, 'timeoutMs');
  const repeats = positiveInt(obj['repeats'], DEFAULTS.repeats, 'repeats');

  return { maxIterations, concurrency, timeoutMs, repeats, cells };
}

/**
 * Parse a comma-separated `--cell` spec into model cells.
 *
 * Each item is `provider/model` or `label=provider/model`.
 * Example: `opus=anthropic/claude-opus-4-8,openai/gpt-5.4`
 */
export function parseCellList(spec: string): ModelCell[] {
  const parts = spec
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new Error('cell list is empty — pass provider/model or label=provider/model');
  }
  return parseBenchConfig({
    cells: parts.map((part, i) => parseCellSpec(part, i)),
  }).cells;
}

/** Build a config from already-parsed cells, applying the usual numeric defaults. */
export function configFromCells(
  cells: ModelCell[],
  overrides?: Partial<Pick<BenchConfig, 'maxIterations' | 'concurrency' | 'timeoutMs' | 'repeats'>>,
): BenchConfig {
  return parseBenchConfig({
    cells,
    maxIterations: overrides?.maxIterations,
    concurrency: overrides?.concurrency,
    timeoutMs: overrides?.timeoutMs,
    repeats: overrides?.repeats,
  });
}

/** Defaults used when the bundled smoke suite runs without a config file. */
export const SMOKE_CONFIG_DEFAULTS = {
  maxIterations: 20,
  concurrency: 2,
  timeoutMs: 180_000,
} as const;

/** Defaults for the bundled `core` quality suite (real tests, not wiring). */
export const CORE_CONFIG_DEFAULTS = {
  maxIterations: 40,
  concurrency: 2,
  timeoutMs: 600_000,
} as const;

function parseCellSpec(spec: string, index: number): ModelCell {
  const eq = spec.indexOf('=');
  let label: string | undefined;
  let rest = spec;
  if (eq !== -1) {
    label = spec.slice(0, eq).trim();
    rest = spec.slice(eq + 1).trim();
  }
  const slash = rest.indexOf('/');
  if (slash <= 0 || slash === rest.length - 1) {
    throw new Error(
      `cells[${index}] must be provider/model or label=provider/model (got ${JSON.stringify(spec)})`,
    );
  }
  const provider = rest.slice(0, slash).trim();
  const model = rest.slice(slash + 1).trim();
  if (!provider || !model) {
    throw new Error(
      `cells[${index}] must be provider/model or label=provider/model (got ${JSON.stringify(spec)})`,
    );
  }
  const cell: ModelCell = {
    label: label && label.length > 0 ? label : `${provider}/${model}`,
    provider,
    model,
  };
  return cell;
}

/** Load and validate a `bench.config.json` from disk. */
export async function loadBenchConfig(path: string): Promise<BenchConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (err) {
    /* v8 ignore next 2 -- readFile rejects with an Error; the String(err) branch is defensive. */
    throw new Error(
      `cannot read bench config at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    /* v8 ignore next 2 -- JSON.parse throws a SyntaxError; the String(err) branch is defensive. */
    throw new Error(
      `bench config at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return parseBenchConfig(parsed);
}

function positiveInt(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return Math.floor(value);
}
