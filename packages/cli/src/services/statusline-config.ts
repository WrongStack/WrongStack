import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ERROR_CODES, FsError } from '@wrongstack/core/types';
import { atomicWrite, resolveWstackPaths, toErrorMessage } from '@wrongstack/core/utils';

const CONFIG_ENV = 'WRONGSTACK_STATUSLINE_CONFIG';

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

export const DEFAULTS: StatuslineConfig = Object.fromEntries(
  STATUSLINE_CONFIG_KEYS.map((key) => [key, true]),
) as StatuslineConfig;

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

function normalizeStatuslineConfig(value: unknown): StatuslineConfig {
  const config: StatuslineConfig = { ...DEFAULTS };
  if (!isRecord(value)) return config;
  for (const key of STATUSLINE_CONFIG_KEYS) {
    if (typeof value[key] === 'boolean') config[key] = value[key];
  }
  return config;
}

function isMissingKnownStatuslineKeys(value: unknown): boolean {
  return !isRecord(value) || STATUSLINE_CONFIG_KEYS.some((key) => typeof value[key] !== 'boolean');
}

export async function loadStatuslineConfig(): Promise<StatuslineConfig> {
  try {
    const raw = await fs.readFile(resolveConfigPath(), 'utf8');
    return normalizeStatuslineConfig(JSON.parse(raw));
  } catch {
    return { ...DEFAULTS };
  }
}

export async function ensureStatuslineConfig(): Promise<StatuslineConfig> {
  try {
    const raw = await fs.readFile(resolveConfigPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const config = normalizeStatuslineConfig(parsed);
    if (isMissingKnownStatuslineKeys(parsed)) await saveStatuslineConfig(config);
    return config;
  } catch (error) {
    if (isRecord(error) && error['code'] === 'ENOENT') {
      const config = { ...DEFAULTS };
      await saveStatuslineConfig(config);
      return config;
    }
    return { ...DEFAULTS };
  }
}

export async function saveStatuslineConfig(config: StatuslineConfig): Promise<void> {
  const configPath = resolveConfigPath();
  try {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await atomicWrite(configPath, JSON.stringify(config, null, 2));
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
