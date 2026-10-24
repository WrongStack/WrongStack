import { createHash } from 'node:crypto';
import { open, readdir, stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import type { JSONSchema, Plugin, PluginAPI } from '@wrongstack/contracts/types';
import { validateAgainstSchema } from '@wrongstack/core/utils';
import { safePath } from '@wrongstack/plugin-sdk/runtime/sandbox';
import { runRunnerCommand } from '../runtime/index.js';

export type Data = Record<string, unknown>;
export interface WorkflowContext {
  root: string;
  signal: AbortSignal;
  api: PluginAPI;
  state: Map<string, unknown>;
}
export interface WorkflowSpec {
  name: string;
  description: string;
  tools: Array<{
    name: string;
    description: string;
    properties: Record<string, JSONSchema>;
    required?: string[];
    mutating?: boolean;
    capabilities?: readonly string[];
    run(input: Data, context: WorkflowContext): Promise<unknown>;
  }>;
}
export const stringField = { type: 'string', minLength: 1 } as const;
export const filesField = {
  type: 'array',
  items: stringField,
  minItems: 1,
  maxItems: 2000,
} as const;
export const commandField: JSONSchema = {
  type: 'object',
  required: ['program'],
  additionalProperties: false,
  properties: {
    program: stringField,
    args: { type: 'array', items: { type: 'string' } },
    cwd: stringField,
    timeoutMs: { type: 'integer', minimum: 1, maximum: 300000 },
  },
};

export function object(value: unknown): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected an object');
  return value as Data;
}
export function str(value: unknown, label = 'value'): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0'))
    throw new Error(`${label} must be a non-empty string`);
  return value;
}
export function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 2000)
    throw new Error('Expected an array of up to 2000 strings');
  return value.map((item) => str(item));
}
export function rows(value: unknown): Data[] {
  if (!Array.isArray(value) || value.length > 2000)
    throw new Error('Expected an array of up to 2000 objects');
  return value.map(object);
}
export function integer(value: unknown, fallback: number, min = 1, max = 300000): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw new Error(`Expected integer in ${min}..${max}`);
  return value;
}
export function projectPath(root: string, value: unknown): string {
  const path = safePath(str(value, 'path'), { projectRoot: root });
  if (!path) throw new Error('Path must resolve inside the project');
  return path;
}
export function digest(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
export async function readBytes(root: string, value: unknown): Promise<Buffer> {
  const file = await open(projectPath(root, value), 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 2_000_000)
      throw new Error('Expected a regular file no larger than 2 MB');
    const buffer = Buffer.alloc(Math.min(info.size + 1, 2_000_001));
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total !== info.size) throw new Error('File changed during read; retry with stable inputs');
    return buffer.subarray(0, total);
  } finally {
    await file.close();
  }
}
export async function read(root: string, value: unknown): Promise<string> {
  return (await readBytes(root, value)).toString('utf8');
}
export async function json(root: string, value: unknown): Promise<Data> {
  return object(JSON.parse(await read(root, value)));
}
export async function fingerprints(root: string, paths: string[]): Promise<Record<string, string>> {
  if (!paths.length) throw new Error('At least one evidence file is required');
  const result: Record<string, string> = Object.create(null);
  for (const path of paths) {
    const canonical = projectPath(root, path);
    result[relative(root, canonical).replaceAll('\\', '/')] = digest(
      await readBytes(root, canonical),
    );
  }
  return result;
}
export async function walk(root: string, folder = '.'): Promise<string[]> {
  const result: string[] = [];
  const pending = [projectPath(root, folder)];
  let visited = 0;
  while (pending.length) {
    const parent = pending.pop()!;
    for (const entry of await readdir(parent, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const path = resolve(parent, entry.name);
      if (
        entry.isDirectory() &&
        !['node_modules', '.git', 'dist', '.next', 'coverage', '.wrongstack'].includes(entry.name)
      )
        pending.push(path);
      if (entry.isFile()) result.push(relative(root, path).replaceAll('\\', '/'));
      if (result.length > 20000) throw new Error('Scan exceeds 20000 files; narrow the scope');
    }
    visited++;
    if (visited > 5000)
      throw new Error('Directory scan exceeds 5000 directories; narrow the scope');
  }
  return result;
}
export async function run(command: unknown, context: WorkflowContext) {
  const input = object(command);
  const program = str(input.program, 'program');
  const args = input.args === undefined ? [] : strings(input.args);
  const cwd = input.cwd === undefined ? context.root : projectPath(context.root, input.cwd);
  if (!(await stat(cwd)).isDirectory()) throw new Error('Command cwd must be a directory');
  context.signal.throwIfAborted();
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const result = await runRunnerCommand([program, ...args], {
    cwd,
    projectRoot: context.root,
    timeoutMs: integer(input.timeoutMs, 60000),
    signal: context.signal,
  });
  context.signal.throwIfAborted();
  return {
    ...result,
    passed: result.code === 0 && !result.timedOut && !result.spawnError,
    program,
    args,
    cwd,
    startedAt,
    durationMs: Date.now() - started,
  };
}

/** Per-host state and cancellation: one loaded module can serve several hosts. */
export function workflowPlugin(spec: WorkflowSpec): Plugin {
  const hosts = new WeakMap<
    PluginAPI,
    {
      projects: Map<string, Map<string, unknown>>;
      abort: AbortController;
      calls: number;
      errors: number;
    }
  >();
  return {
    name: spec.name,
    version: '0.1.0',
    apiVersion: '^0.1.10',
    description: spec.description,
    capabilities: { tools: true },
    defaultConfig: { enabled: true },
    configSchema: {
      type: 'object',
      properties: {
        enabled: {
          type: 'boolean',
          default: true,
          description: 'Enable this workflow after the plugin is loaded.',
        },
      },
    },
    setup(api) {
      hosts.get(api)?.abort.abort();
      const host = {
        projects: new Map<string, Map<string, unknown>>(),
        abort: new AbortController(),
        calls: 0,
        errors: 0,
      };
      hosts.set(api, host);
      for (const definition of spec.tools) {
        const schema: JSONSchema = {
          type: 'object',
          properties: definition.properties,
          required: definition.required ?? [],
          additionalProperties: false,
        };
        api.tools.register({
          name: definition.name,
          description: definition.description,
          inputSchema: schema,
          permission: definition.mutating ? 'confirm' : 'auto',
          mutating: definition.mutating ?? false,
          riskTier: definition.mutating ? 'standard' : 'safe',
          category: 'Diagnostics',
          capabilities: definition.capabilities ?? (definition.mutating ? ['shell.arbitrary'] : []),
          async execute(raw, ctx, opts) {
            if (
              api.config.extensions?.[spec.name] &&
              object(api.config.extensions[spec.name]).enabled === false
            )
              throw new Error(`${spec.name} is disabled`);
            const signal = AbortSignal.any([
              host.abort.signal,
              ...(opts?.signal ? [opts.signal] : []),
            ]);
            signal.throwIfAborted();
            const input = object(raw);
            const validation = validateAgainstSchema(input, schema);
            if (!validation.ok)
              throw new Error(
                validation.errors.map((error) => `${error.path}: ${error.message}`).join('; '),
              );
            for (const field of definition.required ?? [])
              if (input[field] === undefined) throw new Error(`${field} is required`);
            const root = resolve(ctx?.projectRoot ?? ctx?.cwd ?? process.cwd());
            let state = host.projects.get(root);
            if (!state) {
              state = new Map();
              host.projects.set(root, state);
            }
            host.calls++;
            try {
              const result = await definition.run(input, { root, signal, api, state });
              signal.throwIfAborted();
              return result;
            } catch (error) {
              host.errors++;
              throw error;
            }
          },
        });
      }
    },
    teardown(api) {
      hosts.get(api)?.abort.abort();
      hosts.delete(api);
    },
    async health() {
      return { ok: true, message: `${spec.name}: on-demand workflow; no background workers` };
    },
  };
}
