import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { BenchSuite, BenchTask } from '../types.js';

export const DEFAULT_LOCAL_MANIFEST = 'bench.local.json';

export interface LocalSuiteOptions {
  /** Directory containing `bench.local.json` unless `manifestFile` is supplied. */
  suiteDir: string;
  /** Optional explicit manifest path. Relative paths are resolved from suiteDir. */
  manifestFile?: string | undefined;
}

export interface LocalCommandGrader {
  type: 'command';
  command: string;
  args?: string[] | undefined;
  /** Defaults to true, matching the shared execCommand default. */
  shell?: boolean | undefined;
  /** Optional per-command timeout override. Defaults to the benchmark timeout. */
  timeoutMs?: number | undefined;
  /** Optional captured stdout+stderr cap. Defaults to execCommand's cap. */
  maxBufferBytes?: number | undefined;
  /** Extra environment variables for the grader command. */
  env?: Record<string, string> | undefined;
}

export type LocalAssertion =
  | { type: 'file_exists'; path: string }
  | { type: 'file_not_exists'; path: string }
  | { type: 'file_contains'; path: string; text: string }
  | { type: 'file_not_contains'; path: string; text: string };

export interface LocalTaskMeta {
  manifestFile: string;
  rawId: string;
  templateHash: string;
  grader?: LocalCommandGrader | undefined;
  assertions?: LocalAssertion[] | undefined;
}

interface LocalManifest {
  name?: string | undefined;
  tasks: LocalManifestTask[];
}

interface LocalManifestTask {
  id: string;
  prompt: string;
  templateDir: string;
  templateExclude?: string[] | undefined;
  grader?: LocalCommandGrader | undefined;
  assertions?: LocalAssertion[] | undefined;
}

export function createLocalManifestSuite(opts: LocalSuiteOptions): BenchSuite {
  const suiteDir = path.resolve(opts.suiteDir);
  const manifestFile = path.resolve(
    suiteDir,
    opts.manifestFile ?? DEFAULT_LOCAL_MANIFEST,
  );

  return {
    id: 'local',
    async loadTasks({ limit }) {
      const manifest = await readManifest(manifestFile);
      const seen = new Set<string>();
      const tasks: BenchTask[] = [];
      for (const item of manifest.tasks) {
        const id = `local/${item.id}`;
        if (seen.has(id)) {
          throw new Error(`duplicate local task id "${item.id}" in ${manifestFile}`);
        }
        seen.add(id);

        const templateDir = path.resolve(path.dirname(manifestFile), item.templateDir);
        const templateHash = await hashTemplateDir(templateDir, item.templateExclude);
        const meta: LocalTaskMeta = {
          manifestFile,
          rawId: item.id,
          templateHash,
        };
        if (item.grader) meta.grader = item.grader;
        if (item.assertions) meta.assertions = item.assertions;

        tasks.push({
          id,
          suite: 'local',
          prompt: item.prompt,
          templateDir,
          templateExclude: item.templateExclude,
          meta: meta as never as Record<string, unknown>,
        });
        if (limit !== undefined && tasks.length >= limit) return tasks;
      }
      return tasks;
    },
    subsetId(tasks) {
      const entries = tasks
        .map((task) => {
          const meta = task.meta as never as LocalTaskMeta;
          return {
            assertions: meta.assertions ?? [],
            grader: meta.grader ?? null,
            id: task.id,
            prompt: task.prompt,
            templateExclude: task.templateExclude ?? [],
            templateHash: meta.templateHash,
          };
        })
        .sort((a, b) => a.id.localeCompare(b.id));
      return `local:${hashJson(entries)}`;
    },
  };
}

async function readManifest(manifestFile: string): Promise<LocalManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(manifestFile, 'utf8'));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot read local bench manifest ${manifestFile}: ${detail}`);
  }

  if (!isRecord(parsed)) {
    throw new Error(`local bench manifest ${manifestFile} must be a JSON object`);
  }
  const tasksValue = parsed['tasks'];
  if (!Array.isArray(tasksValue)) {
    throw new Error(`local bench manifest ${manifestFile} is missing a "tasks" array`);
  }
  const name = optionalString(parsed['name'], 'name', manifestFile);
  const tasks = tasksValue.map((task, i) => parseTask(task, `tasks[${i}]`, manifestFile));
  if (tasks.length === 0) {
    throw new Error(`local bench manifest ${manifestFile} has no tasks`);
  }
  return name === undefined ? { tasks } : { name, tasks };
}

function parseTask(value: unknown, field: string, manifestFile: string): LocalManifestTask {
  if (!isRecord(value)) {
    throw new Error(`${manifestFile}: ${field} must be an object`);
  }
  const id = requiredString(value['id'], `${field}.id`, manifestFile);
  const prompt = requiredString(value['prompt'], `${field}.prompt`, manifestFile);
  const templateDir = requiredString(value['templateDir'], `${field}.templateDir`, manifestFile);
  const templateExclude = optionalStringArray(
    value['templateExclude'],
    `${field}.templateExclude`,
    manifestFile,
  );
  const grader = parseOptionalGrader(value['grader'], `${field}.grader`, manifestFile);
  const assertions = parseOptionalAssertions(
    value['assertions'],
    `${field}.assertions`,
    manifestFile,
  );

  if (!grader && (!assertions || assertions.length === 0)) {
    throw new Error(`${manifestFile}: ${field} must define a grader or at least one assertion`);
  }

  const task: LocalManifestTask = { id, prompt, templateDir };
  if (templateExclude) task.templateExclude = templateExclude;
  if (grader) task.grader = grader;
  if (assertions) task.assertions = assertions;
  return task;
}

function parseOptionalGrader(
  value: unknown,
  field: string,
  manifestFile: string,
): LocalCommandGrader | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${manifestFile}: ${field} must be an object`);
  }
  const type = requiredString(value['type'], `${field}.type`, manifestFile);
  if (type !== 'command') {
    throw new Error(`${manifestFile}: ${field}.type must be "command"`);
  }
  const command = requiredString(value['command'], `${field}.command`, manifestFile);
  const args = optionalStringArray(value['args'], `${field}.args`, manifestFile);
  const shell = optionalBoolean(value['shell'], `${field}.shell`, manifestFile);
  const timeoutMs = optionalPositiveNumber(value['timeoutMs'], `${field}.timeoutMs`, manifestFile);
  const maxBufferBytes = optionalPositiveNumber(
    value['maxBufferBytes'],
    `${field}.maxBufferBytes`,
    manifestFile,
  );
  const env = optionalStringRecord(value['env'], `${field}.env`, manifestFile);

  const grader: LocalCommandGrader = { type: 'command', command };
  if (args) grader.args = args;
  if (shell !== undefined) grader.shell = shell;
  if (timeoutMs !== undefined) grader.timeoutMs = timeoutMs;
  if (maxBufferBytes !== undefined) grader.maxBufferBytes = maxBufferBytes;
  if (env) grader.env = env;
  return grader;
}

function parseOptionalAssertions(
  value: unknown,
  field: string,
  manifestFile: string,
): LocalAssertion[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`${manifestFile}: ${field} must be an array`);
  }
  return value.map((item, i) => parseAssertion(item, `${field}[${i}]`, manifestFile));
}

function parseAssertion(value: unknown, field: string, manifestFile: string): LocalAssertion {
  if (!isRecord(value)) {
    throw new Error(`${manifestFile}: ${field} must be an object`);
  }
  const type = requiredString(value['type'], `${field}.type`, manifestFile);
  const assertionPath = requiredString(value['path'], `${field}.path`, manifestFile);
  switch (type) {
    case 'file_exists':
      return { type, path: assertionPath };
    case 'file_not_exists':
      return { type, path: assertionPath };
    case 'file_contains':
      return {
        type,
        path: assertionPath,
        text: requiredString(value['text'], `${field}.text`, manifestFile),
      };
    case 'file_not_contains':
      return {
        type,
        path: assertionPath,
        text: requiredString(value['text'], `${field}.text`, manifestFile),
      };
    default:
      throw new Error(
        `${manifestFile}: ${field}.type must be one of file_exists, file_not_exists, file_contains, file_not_contains`,
      );
  }
}

async function hashTemplateDir(
  root: string,
  exclude?: string[] | undefined,
): Promise<string> {
  const hash = createHash('sha256');
  const excludeSet = new Set(exclude ?? []);

  async function visit(abs: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(abs, { withFileTypes: true });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`cannot read local bench template ${root}: ${detail}`);
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (isExcluded(childRel, excludeSet)) continue;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        hash.update(`dir\0${childRel}\0`);
        await visit(childAbs, childRel);
      } else if (entry.isFile()) {
        hash.update(`file\0${childRel}\0`);
        hash.update(await fs.readFile(childAbs));
        hash.update('\0');
      } else if (entry.isSymbolicLink()) {
        hash.update(`link\0${childRel}\0${await fs.readlink(childAbs)}\0`);
      }
    }
  }

  await visit(root, '');
  return hash.digest('hex').slice(0, 12);
}

function isExcluded(rel: string, excludeSet: Set<string>): boolean {
  if (excludeSet.size === 0) return false;
  return rel.split('/').some((segment) => excludeSet.has(segment));
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 12);
}

function requiredString(value: unknown, field: string, manifestFile: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${manifestFile}: ${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, field: string, manifestFile: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new Error(`${manifestFile}: ${field} must be a string`);
  }
  return value;
}

function optionalStringArray(
  value: unknown,
  field: string,
  manifestFile: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${manifestFile}: ${field} must be an array of strings`);
  }
  return value;
}

function optionalBoolean(value: unknown, field: string, manifestFile: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new Error(`${manifestFile}: ${field} must be a boolean`);
  }
  return value;
}

function optionalPositiveNumber(
  value: unknown,
  field: string,
  manifestFile: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${manifestFile}: ${field} must be a positive number`);
  }
  return value;
}

function optionalStringRecord(
  value: unknown,
  field: string,
  manifestFile: string,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${manifestFile}: ${field} must be an object`);
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') {
      throw new Error(`${manifestFile}: ${field}.${key} must be a string`);
    }
    out[key] = item;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
