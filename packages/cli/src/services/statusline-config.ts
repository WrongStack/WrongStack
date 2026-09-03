import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ERROR_CODES, FsError } from '@wrongstack/core/types';
import {
  clampLine,
  defaultChipEnabledMap,
  STATUSLINE_DENSITY_LEVELS,
  STATUSLINE_ITEMS,
  type StatuslineDensities,
  type StatuslineDensity,
  type StatuslineItem,
  type StatuslineLines,
} from '@wrongstack/core/statusline';
import { atomicWrite, resolveWstackPaths, toErrorMessage } from '@wrongstack/core/utils';

const CONFIG_ENV = 'WRONGSTACK_STATUSLINE_CONFIG';

/**
 * On-disk schema version.
 *  v1 — flat boolean map.
 *  v2 — `{chips, lines}`.
 *  v3 — adds `densities` (per-chip full/short/micro pin).
 */
export const STATUSLINE_CONFIG_VERSION = 3;

/**
 * The persistence vocabulary IS the core contract — one list, so a new chip
 * cannot gain a default line without gaining a toggle (or vice versa). The
 * drift guard in `statusline-contract-drift.test.ts` still asserts it.
 */
export const STATUSLINE_CONFIG_KEYS: readonly StatuslineItem[] = STATUSLINE_ITEMS;

export type StatuslineConfigKey = StatuslineItem;
export type StatuslineConfig = { [K in StatuslineConfigKey]?: boolean | undefined };

/**
 * v3 statusline.json document: the chip on/off map, the sparse per-chip line
 * assignment, and the sparse per-chip density pin. Absent `lines` keys mean
 * "render on the contract's default line" (`DEFAULT_LINES`); absent
 * `densities` keys mean "let the rail fitter choose".
 */
export interface StatuslineDocument {
  version: typeof STATUSLINE_CONFIG_VERSION;
  chips: StatuslineConfig;
  lines: StatuslineLines;
  densities: StatuslineDensities;
}

/**
 * Chip toggles for a brand-new config. Not every chip is on: the static
 * identity trivia in `DEFAULT_HIDDEN_ITEMS` starts off, because each costs
 * 10–30 permanent columns and is recoverable from a slash command. An
 * existing file's explicit map always wins over this.
 */
export const DEFAULTS: StatuslineConfig = defaultChipEnabledMap();

function emptyDocument(): StatuslineDocument {
  return {
    version: STATUSLINE_CONFIG_VERSION,
    chips: { ...DEFAULTS },
    lines: {},
    densities: {},
  };
}

function resolveConfigPath(): string {
  const override = process.env[CONFIG_ENV];
  if (override) return override;
  const paths = resolveWstackPaths({
    projectRoot: process.cwd(),
    ...(process.env['WRONGSTACK_HOME'] ? {} : { userHome: process.env.HOME ?? os.homedir() }),
  });
  return paths.profileStatuslineConfig(paths.profileName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeChips(value: unknown): StatuslineConfig {
  const config: StatuslineConfig = { ...DEFAULTS };
  if (!isRecord(value)) return config;
  for (const key of STATUSLINE_CONFIG_KEYS) {
    if (typeof value[key] === 'boolean') config[key] = value[key];
  }
  return config;
}

/**
 * Line assignments: only contract keys are accepted (unknown keys dropped),
 * integer values are clamped into 1–4 (the same defense the renderer's
 * partition applies to raw data), and anything non-numeric is dropped.
 */
function normalizeLines(value: unknown): StatuslineLines {
  const lines: StatuslineLines = {};
  if (!isRecord(value)) return lines;
  for (const key of STATUSLINE_CONFIG_KEYS) {
    const raw = value[key];
    if (typeof raw !== 'number' || !Number.isInteger(raw)) continue;
    lines[key] = clampLine(raw);
  }
  return lines;
}

/**
 * Density pins: only contract keys with a real level survive. `auto` is the
 * absence of a pin, so it is normalized away rather than stored — that keeps
 * the file sparse and makes "did the user pin this?" a single check.
 */
function normalizeDensities(value: unknown): StatuslineDensities {
  const densities: StatuslineDensities = {};
  if (!isRecord(value)) return densities;
  for (const key of STATUSLINE_CONFIG_KEYS) {
    const raw = value[key];
    if (typeof raw !== 'string') continue;
    if (!(STATUSLINE_DENSITY_LEVELS as readonly string[]).includes(raw)) continue;
    densities[key] = raw as StatuslineDensity;
  }
  return densities;
}

/**
 * Interpret raw file contents. A `{chips|lines|densities}` document is read
 * as-is; anything else — including the v1 flat boolean map — is treated as
 * the chips map with no layout overrides. A v2/v3-shaped file with a missing
 * `version` is still honored (keyed on the records it does carry) so a
 * hand-edited file cannot silently reset chip toggles to defaults.
 */
function parseDocument(value: unknown): StatuslineDocument {
  // Detection accepts a `lines`- or `densities`-only document too: a
  // hand-edit that drops the chips record must not silently discard the
  // stored layout (chips fall back to DEFAULTS; layout is preserved).
  if (
    isRecord(value) &&
    (isRecord(value['chips']) || isRecord(value['lines']) || isRecord(value['densities']))
  ) {
    return {
      version: STATUSLINE_CONFIG_VERSION,
      chips: normalizeChips(value['chips']),
      lines: normalizeLines(value['lines']),
      densities: normalizeDensities(value['densities']),
    };
  }
  return {
    version: STATUSLINE_CONFIG_VERSION,
    chips: normalizeChips(value),
    lines: {},
    densities: {},
  };
}

function isMissingKnownChips(value: unknown): boolean {
  return !isRecord(value) || STATUSLINE_CONFIG_KEYS.some((key) => typeof value[key] !== 'boolean');
}

/**
 * True when the on-disk shape needs a normalization rewrite: flat (v1) maps,
 * wrong/missing versions, incomplete chips, or non-canonical `lines` /
 * `densities` are all migrated to the canonical v3 document on the next
 * ensure/save.
 */
function needsRewrite(value: unknown): boolean {
  if (isRecord(value) && isRecord(value['chips'])) {
    if (value['version'] !== STATUSLINE_CONFIG_VERSION) return true;
    if (isMissingKnownChips(value['chips'])) return true;
    // A missing/non-record layout record is malformed, not canonical.
    if (!isRecord(value['lines']) || !isRecord(value['densities'])) return true;
    // Rewrite when the layout is not already canonical so clamped/dropped
    // values do not persist indefinitely on disk.
    return (
      JSON.stringify(normalizeLines(value['lines'])) !== JSON.stringify(value['lines']) ||
      JSON.stringify(normalizeDensities(value['densities'])) !== JSON.stringify(value['densities'])
    );
  }
  return true;
}

export async function loadStatuslineConfig(): Promise<StatuslineDocument> {
  try {
    const raw = await fs.readFile(resolveConfigPath(), 'utf8');
    return parseDocument(JSON.parse(raw));
  } catch {
    return emptyDocument();
  }
}

async function quarantineCorruptConfig(): Promise<boolean> {
  try {
    const configPath = resolveConfigPath();
    await fs.rename(configPath, `${configPath}.corrupt-${Date.now()}`);
    return true;
  } catch {
    return false;
  }
}

export async function ensureStatuslineConfig(): Promise<StatuslineDocument> {
  let raw: unknown;
  let config: StatuslineDocument;
  let sawFile = true;
  try {
    raw = JSON.parse(await fs.readFile(resolveConfigPath(), 'utf8'));
    config = parseDocument(raw);
  } catch (error) {
    if (isRecord(error) && error['code'] === 'ENOENT') {
      sawFile = false;
      config = emptyDocument();
    } else {
      // Unreadable or corrupt file (EACCES, partial write, bad JSON, …):
      // quarantine the original so the defaults write below can never destroy
      // the user's chips/layout, then start fresh. If even the rename fails we
      // return defaults WITHOUT writing — a failed load beats a silent reset.
      if (!(await quarantineCorruptConfig())) return emptyDocument();
      sawFile = false;
      config = emptyDocument();
    }
  }
  // Create-on-missing and migration/backfill rewrites are best-effort: a
  // failed write must not quarantine the (valid) file we just read, so a
  // normalization failure keeps serving the parsed in-memory config.
  if (!sawFile || needsRewrite(raw)) {
    try {
      await saveStatuslineConfig(config);
    } catch {
      return config;
    }
  }
  return config;
}

export async function saveStatuslineConfig(config: StatuslineDocument): Promise<void> {
  const configPath = resolveConfigPath();
  try {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await atomicWrite(
      configPath,
      JSON.stringify(
        {
          version: STATUSLINE_CONFIG_VERSION,
          chips: normalizeChips(config.chips),
          lines: normalizeLines(config.lines),
          densities: normalizeDensities(config.densities),
        },
        null,
        2,
      ),
    );
  } catch (error) {
    throw new FsError({
      message: toErrorMessage(error),
      code:
        error instanceof Error && error.message.includes('mkdir')
          ? ERROR_CODES.FS_MKDIR_FAILED
          : ERROR_CODES.FS_ATOMIC_WRITE_FAILED,
      path: configPath,
      cause: error,
    });
  }
}

/** Load just the per-chip line assignment (defaults to {} when unassigned). */
export async function loadStatuslineLines(): Promise<StatuslineLines> {
  return (await loadStatuslineConfig()).lines;
}

/** Load just the per-chip density pins (defaults to {} when unpinned). */
export async function loadStatuslineDensities(): Promise<StatuslineDensities> {
  return (await loadStatuslineConfig()).densities;
}

/**
 * Persist a new layout (lines and/or densities) while preserving the stored
 * chip toggles. Values are re-normalized (unknown keys dropped, clamped) so a
 * malformed caller cannot write garbage to disk.
 */
export async function saveStatuslineLayout(layout: {
  lines?: StatuslineLines | undefined;
  densities?: StatuslineDensities | undefined;
}): Promise<void> {
  // ensure (not load) so a corrupt file is quarantined before the RMW —
  // otherwise the defaults write would silently destroy the stored chips.
  const doc = await ensureStatuslineConfig();
  await saveStatuslineConfig({
    ...doc,
    lines: normalizeLines(layout.lines ?? doc.lines),
    densities: normalizeDensities(layout.densities ?? doc.densities),
  });
}

/** Back-compat alias: persist only the line assignment. */
export async function saveStatuslineLines(lines: StatuslineLines): Promise<void> {
  await saveStatuslineLayout({ lines });
}
