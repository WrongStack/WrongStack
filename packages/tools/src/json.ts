import * as fs from 'node:fs/promises';
import type { Tool } from '@wrongstack/core';

interface JsonInput {
  file?: string | undefined;
  data?: string | undefined;
  query?: string | undefined;
  format?: 'json' | 'json5' | 'yaml' | undefined;
  validate?: boolean | undefined;
}

interface JsonOutput {
  data: unknown;
  formatted: string;
  type: string;
  keys?: string[] | undefined;
  query_result?: unknown | undefined;
  error?: string | undefined;
}

export const jsonTool: Tool<JsonInput, JsonOutput> = {
  name: 'json',
  category: 'Data',
  description:
    'Parse, pretty-print, query, and convert between JSON, JSON5, and YAML. Supports simple path-based queries.',
  usageHint:
    'VERY USEFUL FOR DATA INSPECTION:\n\n' +
    '- Use on package.json, tsconfig, config files, or any structured data.\n' +
    '- `query` lets you extract specific values without reading the whole file.\n' +
    '- Great for validating that a file has the expected structure.\n' +
    'Prefer this over raw `read` + manual parsing when dealing with configuration or data files.',
  permission: 'auto',
  mutating: false,
  timeoutMs: 5_000,
  capabilities: ['fs.read'],
  inputSchema: {
    type: 'object',
    properties: {
      file: { type: 'string', description: 'Path to JSON/JSON5/YAML file' },
      data: { type: 'string', description: 'JSON/JSON5/YAML string (alternative to file)' },
      query: {
        type: 'string',
        description: 'JMESPath-like query (e.g. "a.b[0].c" or "a[*].name")',
      },
      format: {
        type: 'string',
        enum: ['json', 'json5', 'yaml'],
        description: 'Output format (default: json)',
      },
      validate: {
        type: 'boolean',
        description: 'Validate syntax only, no output (default: false)',
      },
    },
  },
  async execute(input) {
    const format = input.format ?? 'json';

    let parsed: unknown;
    let raw: string;

    if (input.file) {
      try {
        raw = await fs.readFile(input.file, 'utf8');
      } catch {
        return { data: null, formatted: '', type: 'unknown', error: `Could not read file` };
      }
    } else if (input.data) {
      raw = input.data;
    } else {
      return { data: null, formatted: '', type: 'unknown', error: 'Provide file or data' };
    }

    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return {
        data: null,
        formatted: '',
        type: 'unknown',
        error: `Parse failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }

    if (input.validate) {
      return {
        data: parsed,
        formatted: 'valid',
        type: Array.isArray(parsed) ? 'array' : typeof parsed,
        keys:
          typeof parsed === 'object' && parsed !== null ? Object.keys(parsed as object) : undefined,
      };
    }

    const queryResult = input.query ? query(parsed, input.query) : undefined;
    const formatted = formatOutput(queryResult ?? parsed, format);

    return {
      data: parsed,
      formatted,
      type: Array.isArray(parsed) ? 'array' : typeof parsed,
      keys:
        typeof parsed === 'object' && parsed !== null ? Object.keys(parsed as object) : undefined,
      query_result: queryResult,
    };
  },
};

function query(data: unknown, path: string): unknown {
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let current: unknown = data;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;

    const idx = Number(part);
    if (!Number.isNaN(idx) && Array.isArray(current)) {
      current = current[idx];
    } else if (typeof current === 'object' && current !== null) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
}

function formatOutput(data: unknown, format: string): string {
  if (format === 'json5') {
    return JSON.stringify(data, null, 2)
      .replace(/,\s*}/g, '}')
      .replace(/,\s*\]/g, ']');
  }
  if (format === 'yaml') {
    return toYaml(data);
  }
  return JSON.stringify(data, null, 2);
}

function toYaml(data: unknown, indent = 0): string {
  if (data === null) return 'null\n';
  if (data === undefined) return '';
  if (typeof data === 'boolean') return String(data) + '\n';
  if (typeof data === 'number') return String(data) + '\n';
  if (typeof data === 'string') {
    if (data.includes('\n') || data.includes(':') || data.includes('#')) {
      return `"${data.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"\n`;
    }
    return data + '\n';
  }
  if (Array.isArray(data)) {
    if (data.length === 0) return '[]\n';
    const prefix = '  '.repeat(indent);
    return data.map((item) => `${prefix}- ${toYaml(item, indent + 1).trimStart()}`).join('');
  }
  if (typeof data === 'object') {
    const prefix = '  '.repeat(indent);
    const entries = Object.entries(data as Record<string, unknown>);
    return entries.map(([k, v]) => `${prefix}${k}: ${toYaml(v, indent + 1)}`).join('');
  }
  return String(data) + '\n';
}
