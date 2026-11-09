import type { ServerConfig } from '../types.js';
import { SUPPORTED_LANGUAGES } from './install.js';

type LspSubcommand =
  | { type: 'list' }
  | { type: 'status' }
  | { type: 'install'; language: string }
  | { type: 'add'; name: string; config: ServerConfig }
  | { type: 'start'; name?: string | undefined }
  | { type: 'stop'; name?: string | undefined }
  | { type: 'restart'; name?: string | undefined }
  | { type: 'diagnostics'; file?: string | undefined }
  | { type: 'remove'; name: string }
  | { type: 'enable'; name: string }
  | { type: 'disable'; name: string }
  | { type: 'help' };

export function parseArgs(args: string): LspSubcommand {
  const parts = tokenizeArgs(args);
  if (parts.length === 0) return { type: 'list' };

  const sub = parts[0]!.toLowerCase();

  if (sub === 'list' || sub === 'ls') return { type: 'list' };
  if (sub === 'status' || sub === 'stat') return { type: 'status' };
  if (sub === 'help' || sub === 'h' || sub === '--help') return { type: 'help' };

  if (sub === 'install') {
    const lang = parts[1];
    if (!lang) return { type: 'help' };
    return { type: 'install', language: lang };
  }

  if (sub === 'add') {
    const name = parts[1];
    if (!name) return { type: 'help' };
    if (parts.length === 2 && SUPPORTED_LANGUAGES.includes(name.toLowerCase())) {
      return { type: 'install', language: name };
    }
    const values = optionValues(parts.slice(2));
    const command = values.single.get('command')?.trim();
    const languages = splitCsv(values.single.get('languages'));
    if (!command || languages.length === 0 || values.invalid) return { type: 'help' };
    const rawTimeout = values.single.get('timeout')?.trim() ?? '15000';
    const timeout = /^\d+$/.test(rawTimeout) ? Number(rawTimeout) : Number.NaN;
    if (!Number.isSafeInteger(timeout) || timeout <= 0) return { type: 'help' };
    const extensions = values.multi.get('extension') ?? [];
    const fileExtensions = extensionMappings(extensions);
    if (extensions.length > 0 && !fileExtensions) return { type: 'help' };
    return {
      type: 'add',
      name,
      config: {
        command,
        args: values.multi.get('arg') ?? [],
        languages,
        ...(fileExtensions ? { fileExtensions } : {}),
        rootPatterns: values.multi.get('root') ?? [],
        startupTimeoutMs: timeout,
        enabled: true,
      },
    };
  }

  if (sub === 'start') return { type: 'start', name: parts[1] };
  if (sub === 'stop') return { type: 'stop', name: parts[1] };
  if (sub === 'restart' || sub === 'reload') return { type: 'restart', name: parts[1] };

  if (sub === 'diagnostics' || sub === 'diag') {
    return { type: 'diagnostics', file: parts[1] };
  }

  if (sub === 'remove' || sub === 'rm' || sub === 'delete') {
    const name = parts[1];
    if (!name) return { type: 'help' };
    return { type: 'remove', name };
  }

  if (sub === 'enable') {
    const name = parts[1];
    if (!name) return { type: 'help' };
    return { type: 'enable', name };
  }

  if (sub === 'disable') {
    const name = parts[1];
    if (!name) return { type: 'help' };
    return { type: 'disable', name };
  }

  return { type: 'help' };
}

export function tokenizeArgs(input: string): string[] {
  return [...input.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map(
    (match) => match[1] ?? match[2] ?? match[3]!,
  );
}

export function optionValues(parts: string[]): {
  single: Map<string, string>;
  multi: Map<string, string[]>;
  invalid: boolean;
} {
  const single = new Map<string, string>();
  const multi = new Map<string, string[]>();
  let invalid = false;
  let index = 0;
  while (index < parts.length) {
    const token = parts[index];
    if (!token?.startsWith('--')) {
      invalid = true;
      break;
    }
    const eqIndex = token.indexOf('=');
    let key: string;
    let value: string | undefined;
    if (eqIndex !== -1) {
      key = token.slice(2, eqIndex);
      value = token.slice(eqIndex + 1);
      index += 1;
    } else {
      key = token.slice(2);
      value = parts[index + 1];
      if (value === undefined) {
        invalid = true;
        break;
      }
      index += 2;
    }
    if (key === 'arg' || key === 'root' || key === 'extension') {
      multi.set(key, [...(multi.get(key) ?? []), value]);
    } else if (key === 'command' || key === 'languages' || key === 'timeout') {
      single.set(key, value);
    } else {
      invalid = true;
    }
  }
  return { single, multi, invalid };
}

export function splitCsv(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function extensionMappings(values: string[]): Record<string, string> | undefined {
  if (values.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const value of values) {
    const separator = value.indexOf('=');
    if (separator <= 0 || separator === value.length - 1) return undefined;
    const key = value.slice(0, separator).toLowerCase();
    out[key.startsWith('.') || !key.includes('.') ? key : `.${key}`] = value.slice(separator + 1);
  }
  return out;
}
