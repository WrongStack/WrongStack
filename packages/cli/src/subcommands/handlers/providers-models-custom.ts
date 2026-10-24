import * as fs from 'node:fs/promises';
import type { Capabilities } from '@wrongstack/contracts/types';
import {
  ConfigError,
  type CustomModelDefinition,
  type ProviderConfig,
} from '@wrongstack/contracts/types';
import { decryptConfigSecretsForRewrite, encryptConfigSecrets } from '@wrongstack/core/security';
import {
  atomicWrite,
  backupConfigFile,
  color,
  expectDefined,
  withFileLock,
} from '@wrongstack/core/utils';
import { activeProfileConfigPath } from '../../profile-config-path.js';
import { mutateConfigProviders } from '../../provider-config-utils.js';
import type { SubcommandHandler } from '../contracts.js';
import {
  discoverProviderModels,
  publishProviderConfig,
  usesAccountCatalog,
} from './providers-models-visibility.js';

/** Parse `--key value` flags from a flat args array. */
export function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = expectDefined(args[i]);
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const name = a.slice(2);
        if (i + 1 < args.length && !args[i + 1]?.startsWith('--')) {
          flags[name] = args[++i] ?? '';
        } else {
          flags[name] = true;
        }
      }
    }
  }
  return flags;
}

/** Filter out flag args and return only positional (non-flag) args. */
export function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = expectDefined(args[i]);
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq === -1) {
        // If the next arg is a value (not a flag), skip it
        if (i + 1 < args.length && !args[i + 1]?.startsWith('--')) {
          i++;
        }
      }
      continue;
    }
    out.push(a);
  }
  return out;
}

export function fmtPrice(usdPer1M: number | undefined): string {
  if (usdPer1M === undefined) return color.dim('?');
  const value = usdPer1M >= 10 ? usdPer1M.toFixed(1) : usdPer1M.toFixed(2);
  return '$' + value;
}

export async function modelsResetCustomModel(
  providerId: string,
  modelId: string,
  saved: ProviderConfig,
  deps: Parameters<SubcommandHandler>[1],
): Promise<number> {
  if (!saved.customModels || !Object.hasOwn(saved.customModels, modelId)) {
    deps.renderer.writeInfo(`${providerId}/${modelId} has no custom definition; nothing to reset.`);
    return 0;
  }
  await mutateConfigProviders(
    activeProfileConfigPath(deps.paths, deps.config),
    deps.vault,
    (providers) => {
      const p = providers[providerId];
      if (!p?.customModels) return;
      delete p.customModels[modelId];
      if (Object.keys(p.customModels).length === 0) delete p.customModels;
    },
  );
  const { [modelId]: _dropped, ...rest } = saved.customModels;
  const next: ProviderConfig = { ...saved };
  if (Object.keys(rest).length > 0) next.customModels = rest;
  else delete next.customModels;
  publishProviderConfig(deps, providerId, next);
  deps.renderer.writeInfo(`Reset ${providerId}/${modelId} to the catalog definition.`);
  return 0;
}

export async function modelsReset(
  args: string[],
  deps: Parameters<SubcommandHandler>[1],
): Promise<number> {
  const providerId = args[0];
  const modelId = args[1];
  if (!providerId) {
    deps.renderer.writeError('Usage: wstack models reset <provider> [model]');
    return 1;
  }
  const saved = deps.config.providers?.[providerId];
  if (!saved) {
    deps.renderer.writeError(`Provider "${providerId}" is not configured.`);
    return 1;
  }
  // `reset <provider> <model>` drops that model's custom definition so the
  // catalog's values apply again. It used to ignore the model and fall through
  // to the provider-wide branch below, wiping the provider's visible list.
  if (modelId) return modelsResetCustomModel(providerId, modelId, saved, deps);
  if (saved.models === undefined) {
    deps.renderer.writeInfo(`${providerId} already shows the full catalog model list.`);
    return 0;
  }
  await mutateConfigProviders(
    activeProfileConfigPath(deps.paths, deps.config),
    deps.vault,
    (providers) => {
      const p = providers[providerId];
      if (!p) return;
      delete p.models;
    },
  );
  const nextProvider = { ...saved };
  delete nextProvider.models;
  publishProviderConfig(deps, providerId, nextProvider);
  deps.renderer.writeInfo(
    `Reset visible model list for ${providerId} to the full catalog default.`,
  );
  return 0;
}

export async function modelsCaps(
  args: string[],
  deps: Parameters<SubcommandHandler>[1],
): Promise<number> {
  const providerId = args[0] ?? deps.config.provider;
  const modelId = args[1] ?? deps.config.model;
  if (!providerId || !modelId) {
    deps.renderer.writeError('Usage: wstack models caps [provider] [model]');
    deps.renderer.write(color.dim('Defaults to current configured provider/model when omitted.\n'));
    return 1;
  }

  if (usesAccountCatalog(deps.config.providers?.[providerId])) {
    await discoverProviderModels(deps, [providerId], providerId);
  }
  const resolved = await deps.modelsRegistry.getModel(providerId, modelId);
  if (!resolved) {
    deps.renderer.writeError('Model not found in catalog: ' + providerId + '/' + modelId);
    deps.renderer.write(
      color.dim('Run `wstack models refresh` or add a custom model if this is expected.\n'),
    );
    return 1;
  }

  const caps = resolved.capabilities;
  const flags = [
    caps.tools ? 'tools' : undefined,
    caps.vision ? 'vision' : undefined,
    caps.reasoning ? 'reasoning' : undefined,
  ].filter((v): v is string => v !== undefined);
  const rc = caps.reasoningConfig;
  const cost = resolved.cost;

  deps.renderer.write(
    color.bold('Model capabilities') + ' ' + color.dim(providerId + '/' + modelId) + '\n',
  );
  deps.renderer.write(
    '  context:      ' +
      (caps.maxContext ? color.yellow(String(caps.maxContext)) : color.dim('?')) +
      '\n',
  );
  if (caps.maxOutput !== undefined) {
    deps.renderer.write('  max output:   ' + color.yellow(String(caps.maxOutput)) + '\n');
  }
  if (caps.knowledge) deps.renderer.write('  knowledge:    ' + caps.knowledge + '\n');
  deps.renderer.write(
    '  flags:        ' + (flags.length > 0 ? flags.join(', ') : color.dim('(none)')) + '\n',
  );
  deps.renderer.write(
    '  pricing/1M:   input ' +
      fmtPrice(cost?.input) +
      '  output ' +
      fmtPrice(cost?.output) +
      '  cacheR ' +
      fmtPrice(cost?.cache_read) +
      '\n',
  );
  if (
    cost?.cache_write !== undefined ||
    cost?.cache_write_5m !== undefined ||
    cost?.cache_write_1h !== undefined
  ) {
    const cacheWrite1h =
      cost.cache_write_1h ?? (cost.input !== undefined ? cost.input * 2 : undefined);
    deps.renderer.write(
      '  cache write:  default ' +
        fmtPrice(cost.cache_write) +
        '  5m ' +
        fmtPrice(cost.cache_write_5m ?? cost.cache_write) +
        '  1h ' +
        fmtPrice(cacheWrite1h) +
        '\n',
    );
  }
  if (rc) {
    deps.renderer.write('  reasoning:\n');
    deps.renderer.write('    default:    ' + rc.default + '\n');
    deps.renderer.write(
      '    disable:    ' + (rc.disableSupported ? 'supported' : 'unsupported') + '\n',
    );
    deps.renderer.write(
      '    effort:     ' +
        (rc.effortSupported === undefined
          ? 'not enumerated (model reasons; any level forwarded)'
          : rc.effortSupported
            ? rc.effortLevels.join(', ')
            : 'unsupported') +
        '\n',
    );
    deps.renderer.write('    preserve:   ' + rc.preserveThinking + '\n');
  } else if (caps.reasoning) {
    deps.renderer.write(
      color.dim('  reasoning:    supported, but no detailed config in catalog\n'),
    );
  }
  return 0;
}

/* ------------------------------------------------------------------ */
/*  Custom model management (top-level Config.models)                  */
/* ------------------------------------------------------------------ */

/**
 * Load → mutate → encrypt → atomic-write for the `models` section.
 */
export async function mutateModelsConfig(
  deps: Parameters<SubcommandHandler>[1],
  mutator: (models: Record<string, CustomModelDefinition>) => void,
): Promise<void> {
  const vault = deps.vault;
  const configPath = activeProfileConfigPath(deps.paths, deps.config);
  await withFileLock(configPath, async () => {
    let fileExists = true;
    let raw: string;
    try {
      raw = await fs.readFile(configPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      fileExists = false;
      raw = '{}';
    }
    let parsed: Record<string, unknown>;
    try {
      // A leading UTF-8 BOM is valid (RFC 8259); the config loader accepts it.
      parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as Record<string, unknown>;
    } catch (err) {
      if (fileExists) {
        throw new ConfigError({
          message: `Refusing to overwrite corrupt config at ${configPath} (${(err as Error).message}).`,
          code: 'CONFIG_PARSE_FAILED',
          context: { filePath: configPath, operation: 'mutateModelsConfig' },
        });
      }
      parsed = {};
    }
    const decrypted = decryptConfigSecretsForRewrite(parsed, vault) as Record<string, unknown>;
    const models = (decrypted.models as Record<string, CustomModelDefinition>) ?? {};
    mutator(models);
    decrypted.models = models;
    const encrypted = encryptConfigSecrets(decrypted, vault);
    await backupConfigFile(configPath, { globalRoot: deps.paths.globalRoot });
    await atomicWrite(configPath, JSON.stringify(encrypted, null, 2), { mode: 0o600 });
  });
}

/** Parse a human-readable size like "128k", "1M", "200000" into a number. */
export function parseSizeFlag(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)\s*(k|m|b)?$/.exec(s);
  if (!match) return undefined;
  const num = Number.parseFloat(expectDefined(match[1]));
  const unit = match[2];
  if (unit === 'b') return Math.round(num * 1_000_000_000);
  if (unit === 'm') return Math.round(num * 1_000_000);
  if (unit === 'k') return Math.round(num * 1000);
  return Math.round(num);
}

/**
 * Flags visible to this subcommand.
 *
 * `parseArgs` pulls every `--flag` out of argv and hands the handler only the
 * positional remainder, so a handler parsing just its own `args` sees none of
 * them — `models <provider> --search x` and `models add <id> --tools` both lost
 * theirs silently. `deps.flags` is what that top-level parse captured. The
 * local parse still wins, so a directly-invoked handler (and anything after
 * `--`) keeps overriding it.
 */
export function subcommandFlags(
  args: string[],
  deps: Parameters<SubcommandHandler>[1],
): Record<string, string | boolean> {
  return { ...(deps.flags ?? {}), ...parseFlags(args) };
}

/** Parse a boolean flag like "--tools" / "--no-tools". */
export function parseBoolFlag(
  flags: Record<string, string | boolean>,
  key: string,
): boolean | undefined {
  if (flags[key] === true || flags[key] === 'true') return true;
  if (flags[`no-${key}`] !== undefined) return false;
  return undefined;
}

export async function modelsAdd(
  args: string[],
  deps: Parameters<SubcommandHandler>[1],
): Promise<number> {
  const flags = subcommandFlags(args, deps);
  const pos = positionals(args);
  const modelId = pos[0];

  if (!modelId) {
    deps.renderer.writeError(
      'Usage: wstack models add <modelId> [--provider <id>] [--name <name>] ' +
        '[--max-context <N>] [--max-output <N>] [--tools] [--no-tools] ' +
        '[--vision] [--no-vision] [--reasoning] [--streaming] [--no-streaming] [--json-mode]',
    );
    return 1;
  }

  const existing = deps.config.models?.[modelId];
  if (existing) {
    deps.renderer.writeWarning(`Model "${modelId}" already defined. Overwriting.`);
  }

  const capabilities: Partial<Capabilities> = {};
  const toolsVal = parseBoolFlag(flags, 'tools');
  if (toolsVal !== undefined) capabilities.tools = toolsVal;
  const visionVal = parseBoolFlag(flags, 'vision');
  if (visionVal !== undefined) capabilities.vision = visionVal;
  const streamingVal = parseBoolFlag(flags, 'streaming');
  if (streamingVal !== undefined) capabilities.streaming = streamingVal;
  const reasoningVal = parseBoolFlag(flags, 'reasoning');
  if (reasoningVal !== undefined) capabilities.reasoning = reasoningVal;
  const jsonModeVal = parseBoolFlag(flags, 'json-mode');
  if (jsonModeVal !== undefined) capabilities.jsonMode = jsonModeVal;

  const maxContextRaw = typeof flags['max-context'] === 'string' ? flags['max-context'] : undefined;
  const maxContext = parseSizeFlag(maxContextRaw);
  if (maxContext !== undefined) capabilities.maxContext = maxContext;

  const def: CustomModelDefinition = {};
  const nameFlag = typeof flags['name'] === 'string' ? flags['name'] : undefined;
  const providerFlag = typeof flags['provider'] === 'string' ? flags['provider'] : undefined;
  if (nameFlag) def.name = nameFlag;
  if (providerFlag) def.provider = providerFlag;
  if (Object.keys(capabilities).length > 0) def.capabilities = capabilities;

  const maxOutputRaw = typeof flags['max-output'] === 'string' ? flags['max-output'] : undefined;
  const maxOutput = parseSizeFlag(maxOutputRaw);
  if (maxOutput !== undefined) def.maxOutput = maxOutput;

  await mutateModelsConfig(deps, (models) => {
    models[modelId] = def;
  });

  deps.renderer.writeInfo(`Custom model "${modelId}" ${existing ? 'updated' : 'added'}.`);
  const capLines: string[] = [];
  if (def.capabilities) {
    for (const [k, v] of Object.entries(def.capabilities)) {
      capLines.push(`  ${k}: ${v}`);
    }
  }
  if (def.maxOutput !== undefined) capLines.push(`  maxOutput: ${def.maxOutput}`);
  if (capLines.length > 0) {
    deps.renderer.write(color.dim(capLines.join('\n') + '\n'));
  }
  return 0;
}

export async function modelsRemove(
  args: string[],
  deps: Parameters<SubcommandHandler>[1],
): Promise<number> {
  const modelId = args[0];
  if (!modelId) {
    deps.renderer.writeError('Usage: wstack models remove <modelId>');
    return 1;
  }

  const existing = deps.config.models?.[modelId];
  if (!existing) {
    deps.renderer.writeError(`No custom model "${modelId}" found.`);
    return 1;
  }

  await mutateModelsConfig(deps, (models) => {
    delete models[modelId];
  });

  deps.renderer.writeInfo(`Removed custom model "${modelId}".`);
  return 0;
}

export async function modelsList(
  _args: string[],
  deps: Parameters<SubcommandHandler>[1],
): Promise<number> {
  const models = deps.config.models ?? {};
  const entries = Object.entries(models);

  if (entries.length === 0) {
    deps.renderer.write(color.dim('No custom models defined.\n'));
    deps.renderer.write(
      color.dim('Use `wstack models add <modelId> --max-context 128k --tools`\n'),
    );
    return 0;
  }

  deps.renderer.write(color.bold('Custom models\n'));
  for (const [id, def] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const label = def.name ?? id;
    const provider = def.provider ? ` ${color.dim(`(${def.provider})`)}` : '';
    deps.renderer.write(`  ${color.bold(label)}${provider}\n`);
    if (def.capabilities) {
      for (const [k, v] of Object.entries(def.capabilities)) {
        deps.renderer.write(`    ${color.dim(`${k}:`)} ${v}\n`);
      }
    }
    if (def.maxOutput !== undefined) {
      deps.renderer.write(`    ${color.dim('maxOutput:')} ${def.maxOutput}\n`);
    }
  }
  return 0;
}
