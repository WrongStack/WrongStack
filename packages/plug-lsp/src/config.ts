import { TOKENS } from '@wrongstack/core/kernel';
import type { PluginAPI } from '@wrongstack/core/plugin';
import type { JSONSchema } from '@wrongstack/core/types';
import { PRESETS } from './presets.js';
import type { PlugLSPConfig, ServerConfig, SeverityName } from './types.js';

export const PLUGIN_NAME = '@wrongstack/plug-lsp';

export const DEFAULT_CONFIG: Omit<PlugLSPConfig, 'servers'> = {
  autoStart: 'lazy',
  diagnosticsAfterEdit: 'background',
  diagnosticsWaitMs: 1500,
  severityFilter: ['error', 'warning'],
  maxDiagnosticsPerFile: 5,
  maxDiagnosticsTotal: 50,
  autoDiscover: true,
  logServerOutput: false,
};

export const plugLspConfigSchema: JSONSchema = {
  type: 'object',
  properties: {
    servers: { type: 'object' },
    autoStart: { type: 'string', enum: ['lazy', 'eager', 'never'] },
    diagnosticsAfterEdit: { type: 'string', enum: ['background', 'manual'] },
    diagnosticsWaitMs: { type: 'integer' },
    severityFilter: {
      type: 'array',
      items: { type: 'string', enum: ['error', 'warning', 'info', 'hint'] },
    },
    maxDiagnosticsPerFile: { type: 'integer' },
    maxDiagnosticsTotal: { type: 'integer' },
    autoDiscover: { type: 'boolean' },
    logServerOutput: { type: 'boolean' },
  },
};

export function readPlugLSPConfig(api: PluginAPI): PlugLSPConfig {
  const fromStore = readFromConfigStore(api);
  const raw = fromStore ?? api.config.extensions?.[PLUGIN_NAME] ?? {};
  return mergeConfig(raw);
}

export function mergeConfig(raw: Readonly<Record<string, unknown>>): PlugLSPConfig {
  const servers = normalizeServers(raw.servers);
  const severity = Array.isArray(raw.severityFilter)
    ? raw.severityFilter.filter(isSeverityName)
    : DEFAULT_CONFIG.severityFilter;

  return {
    servers,
    autoStart: oneOf(raw.autoStart, ['lazy', 'eager', 'never'], DEFAULT_CONFIG.autoStart),
    diagnosticsAfterEdit: oneOf(
      raw.diagnosticsAfterEdit,
      ['background', 'manual'],
      DEFAULT_CONFIG.diagnosticsAfterEdit,
    ),
    diagnosticsWaitMs: positiveInt(raw.diagnosticsWaitMs, DEFAULT_CONFIG.diagnosticsWaitMs),
    severityFilter: severity.length > 0 ? severity : DEFAULT_CONFIG.severityFilter,
    maxDiagnosticsPerFile: positiveInt(
      raw.maxDiagnosticsPerFile,
      DEFAULT_CONFIG.maxDiagnosticsPerFile,
    ),
    maxDiagnosticsTotal: positiveInt(raw.maxDiagnosticsTotal, DEFAULT_CONFIG.maxDiagnosticsTotal),
    autoDiscover:
      typeof raw.autoDiscover === 'boolean' ? raw.autoDiscover : DEFAULT_CONFIG.autoDiscover,
    logServerOutput:
      typeof raw.logServerOutput === 'boolean'
        ? raw.logServerOutput
        : DEFAULT_CONFIG.logServerOutput,
  };
}

function readFromConfigStore(api: PluginAPI): Readonly<Record<string, unknown>> | undefined {
  if (!api.container.has(TOKENS.ConfigStore)) return undefined;
  try {
    return api.container.resolve(TOKENS.ConfigStore).getExtension(PLUGIN_NAME);
  } catch {
    return undefined;
  }
}

function normalizeServers(value: unknown): Record<string, ServerConfig> {
  if (!isRecord(value)) return {};
  const out: Record<string, ServerConfig> = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    if (typeof raw.command !== 'string') continue;
    if (!Array.isArray(raw.languages) || raw.languages.some((x) => typeof x !== 'string')) {
      continue;
    }
    out[name] = {
      command: raw.command,
      args: stringArray(raw.args),
      env: stringRecord(raw.env),
      languages: raw.languages,
      fileExtensions: stringRecord(raw.fileExtensions),
      rootPatterns: stringArray(raw.rootPatterns),
      initializationOptions: raw.initializationOptions,
      settings: raw.settings,
      startupTimeoutMs: positiveInt(raw.startupTimeoutMs, 15_000),
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    };
  }
  return out;
}

export function withPresetFallbacks(cfg: PlugLSPConfig): PlugLSPConfig {
  const typescript = PRESETS.typescript;
  return {
    ...cfg,
    servers: Object.keys(cfg.servers).length > 0 || !typescript ? cfg.servers : { typescript },
  };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && allowed.includes(value as T) ? (value as T) : fallback;
}

function positiveInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((x) => typeof x === 'string') ? value : undefined;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function isSeverityName(value: unknown): value is SeverityName {
  return value === 'error' || value === 'warning' || value === 'info' || value === 'hint';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
