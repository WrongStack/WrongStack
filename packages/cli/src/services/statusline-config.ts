import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ERROR_CODES, FsError } from '@wrongstack/core/types';
import type { StatuslineLine, StatuslineLines } from '@wrongstack/core/statusline';
import { atomicWrite, resolveWstackPaths, toErrorMessage } from '@wrongstack/core/utils';

const CONFIG_ENV = 'WRONGSTACK_STATUSLINE_CONFIG';

/** On-disk schema version. v1 was a flat boolean map; v2 nests it under
 *  `chips` alongside the sparse per-chip `lines` assignment. */
export const STATUSLINE_CONFIG_VERSION = 2;

export const STATUSLINE_CONFIG_KEYS = [
  'state',
  'model',
  'context',
  'tokens',
  'cache',
  'cost',
  'queue',
  'hint',
  'index',
  'breaker',
  'yolo',
  'autonomy',
  'eternal_stage',
  'elapsed',
  'project',
  'working_dir',
  'goal',
  'mode',
  'auto_proceed',
  'git',
  'sessions',
  'tools',
  'theme',
  'token_saving',
  'processes',
  'version',
  'dropped_tools',
  'prompt_variant',
  'side_effects',
  'todos',
  'plan',
  'tasks',
  'fleet',
  'brain',
  'debug_stream',
  'enhance',
  'next_steps',
  'mailbox',
  'fleet_agents',
  'memory_context',
] as const;

export type StatuslineConfigKey = (typeof STATUSLINE_CONFIG_KEYS)[number];
export type StatuslineConfig = { [K in StatuslineConfigKey]?: boolean | undefined };

/**
 * v2 statusline.json document: the chip on/off map plus the sparse
 * per-chip line assignment (`StatuslineLines` from the framework-free core
 * contract). Absent `lines` keys mean "render on the contract's default
 * line" (`DEFAULT_LINES`).
 */
export interface StatuslineDocument {
  version: typeof STATUSLINE_CONFIG_VERSION;
  chips: StatuslineConfig;
  lines: StatuslineLines;
}

export const DEFAULTS: StatuslineConfig = Object.fromEntries(
  STATUSLINE_CONFIG_KEYS.map((key) => [key, true]),
) as StatuslineConfig;

function emptyDocument(): StatuslineDocument {
  return { version: STATUSLINE_CONFIG_VERSION, chips: { ...DEFAULTS }, lines: {} };
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
    lines[key] = Math.min(4, Math.max(1, raw)) as StatuslineLine;
  }
  return lines;
}

/**
 * Interpret raw file contents. A `{version:2, chips, lines}` document is
 * read as-is; anything else — including the v1 flat boolean map — is
 * treated as the chips map with no line assignments. A v2-shaped file with
 * a missing `version` is still honored (keyed on the `chips` record) so a
 * hand-edited file cannot silently reset chip toggles to defaults.
 */
function parseDocument(value: unknown): StatuslineDocument {
  // v2 detection accepts a `lines`-only document too: a hand-edit that drops
  // the chips record must not silently discard the stored line assignment
  // (chips fall back to DEFAULTS; lines are preserved verbatim).
  if (isRecord(value) && (isRecord(value['chips']) || isRecord(value['lines']))) {
    return {
      version: STATUSLINE_CONFIG_VERSION,
      chips: normalizeChips(value['chips']),
      lines: normalizeLines(value['lines']),
    };
  }
  return { version: STATUSLINE_CONFIG_VERSION, chips: normalizeChips(value), lines: {} };
}

function isMissingKnownChips(value: unknown): boolean {
  return !isRecord(value) || STATUSLINE_CONFIG_KEYS.some((key) => typeof value[key] !== 'boolean');
}

/**
 * True when the on-disk shape needs a normalization rewrite: flat (v1) maps,
 * wrong/missing versions, incomplete chips, or non-canonical `lines` are all
 * migrated to the canonical v2 document on the next ensure/save.
 */
function needsRewrite(value: unknown): boolean {
  if (isRecord(value) && isRecord(value['chips'])) {
    if (value['version'] !== STATUSLINE_CONFIG_VERSION) return true;
    if (isMissingKnownChips(value['chips'])) return true;
    // A missing/non-record `lines` is malformed, not canonical — rewrite it.
    if (!isRecord(value['lines'])) return true;
    // Rewrite when `lines` is not already canonical so clamped/dropped
    // values do not persist indefinitely on disk.
    return JSON.stringify(normalizeLines(value['lines'])) !== JSON.stringify(value['lines']);
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
      // the user's chips/lines, then start fresh. If even the rename fails we
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

/**
 * Persist a new line assignment while preserving the stored chip toggles.
 * Values are re-normalized (unknown keys dropped, clamped) so a malformed
 * caller cannot write garbage to disk.
 */
export async function saveStatuslineLines(lines: StatuslineLines): Promise<void> {
  // ensure (not load) so a corrupt file is quarantined before the RMW —
  // otherwise the defaults write would silently destroy the stored chips.
  const doc = await ensureStatuslineConfig();
  await saveStatuslineConfig({ ...doc, lines: normalizeLines(lines) });
}
