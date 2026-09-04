import * as fs from 'node:fs/promises';
import { atomicWrite } from './atomic-write.js';
import { FORBIDDEN_PROTO_KEYS } from './deep-merge.js';

export type JsonObject = Record<string, unknown>;
export type JsonPathSegment = string | number;
export type JsonPath = readonly JsonPathSegment[];

export async function readJsonObjectFile(filePath: string): Promise<JsonObject> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
    return isJsonObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function jsonObjectFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function writeJsonObjectFile(filePath: string, value: JsonObject): Promise<void> {
  await atomicWrite(filePath, JSON.stringify(value, null, 2), { mode: 0o600 });
}

export async function updateJsonObjectFile(
  filePath: string,
  mutator: (config: JsonObject) => void | JsonObject | Promise<void | JsonObject>,
): Promise<JsonObject> {
  const config = await readJsonObjectFile(filePath);
  const maybeNext = await mutator(config);
  const next = maybeNext && isJsonObject(maybeNext) ? maybeNext : config;
  await writeJsonObjectFile(filePath, next);
  return next;
}

/**
 * True when a path segment would reach the prototype chain (WS-054).
 *
 * `deepMerge` has guarded these since it was written; these helpers did not,
 * despite being the *write* path for the same config files. The reachable
 * entry point is not hypothetical: `setJsonPath(full, ['mcpServers', name], …)`
 * is called from four places with `name` taken from user- or agent-supplied
 * MCP server configuration.
 *
 * Two distinct severities, worth keeping straight:
 *
 *   - `['constructor', 'prototype', …]` is the SEVERE one. `ensureJsonParent`
 *     walks intermediate segments, so that path traverses to
 *     `Object.prototype` and the final assignment lands on it — polluting
 *     every plain object in the process.
 *   - `__proto__` as a segment is narrower than it first looks: assigning it
 *     re-parents THAT object only, it does not touch `Object.prototype`. Still
 *     a real defect — the intended property is silently not created and the
 *     object starts inheriting attacker-chosen values — but scoped.
 *
 * Both are refused, because a config path has no legitimate reason to contain
 * either.
 */
function isForbiddenSegment(segment: JsonPathSegment): boolean {
  return typeof segment === 'string' && FORBIDDEN_PROTO_KEYS.has(segment);
}

function assertSafePath(path: JsonPath): void {
  if (!Array.isArray(path)) {
    throw new Error('JSON path must be an array of segments');
  }
  for (const segment of path) {
    if (isForbiddenSegment(segment)) {
      throw new Error(`Refusing to use reserved key "${String(segment)}" in a JSON path`);
    }
  }
}

export function getJsonPath(root: unknown, path: JsonPath): unknown {
  // Reads are refused rather than thrown on: a caller asking for `__proto__`
  // gets "not present", which is the honest answer about the config's data.
  if (!Array.isArray(path) || path.some(isForbiddenSegment)) return undefined;
  let current = root;
  for (const segment of path) {
    if (typeof segment === 'number') {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
      continue;
    }
    if (!isJsonObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

export function setJsonPath(root: JsonObject, path: JsonPath, value: unknown): JsonObject {
  // Writes throw rather than silently no-op: a caller trying to set a
  // prototype key is either a bug or an attack, and both deserve to be loud.
  if (root === null || root === undefined) throw new Error('Root config value must be an object');
  assertSafePath(path);
  if (path.length === 0) {
    if (!isJsonObject(value)) throw new Error('Root config value must be an object');
    return value;
  }
  const parent = ensureJsonParent(root, path);
  const leaf = lastPathSegment(path);
  if (typeof leaf === 'number') {
    if (!Array.isArray(parent))
      throw new Error(`Cannot set numeric segment ${leaf} on non-array parent`);
    parent[leaf] = value;
  } else {
    if (!isJsonObject(parent)) throw new Error(`Cannot set property ${leaf} on non-object parent`);
    parent[leaf] = value;
  }
  return root;
}

export function removeJsonPath(root: JsonObject, path: JsonPath): boolean {
  // `'__proto__' in obj` is true for every plain object, so without this the
  // delete branch would run against the prototype rather than report "absent".
  if (!isJsonObject(root) || !Array.isArray(path) || path.some(isForbiddenSegment)) return false;
  if (path.length === 0) return false;
  const parent = getJsonPath(root, path.slice(0, -1));
  const leaf = lastPathSegment(path);
  if (typeof leaf === 'number') {
    if (!Array.isArray(parent) || leaf < 0 || leaf >= parent.length) return false;
    parent.splice(leaf, 1);
    return true;
  }
  if (!isJsonObject(parent) || !(leaf in parent)) return false;
  delete parent[leaf];
  return true;
}

export async function setJsonPathInFile(
  filePath: string,
  path: JsonPath,
  value: unknown,
): Promise<JsonObject> {
  return updateJsonObjectFile(filePath, (config) => setJsonPath(config, path, value));
}

export async function removeJsonPathInFile(filePath: string, path: JsonPath): Promise<JsonObject> {
  return updateJsonObjectFile(filePath, (config) => {
    removeJsonPath(config, path);
  });
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function lastPathSegment(path: JsonPath): JsonPathSegment {
  const segment = path[path.length - 1];
  /* v8 ignore next -- defensive: callers guard path.length === 0 before here */
  if (segment === undefined) throw new Error('Invalid empty JSON path');
  return segment;
}

function ensureJsonParent(root: JsonObject, path: JsonPath): JsonObject | unknown[] {
  // Defence in depth: `setJsonPath` already checked, but this creates
  // intermediate containers and is the other half the finding names, so it
  // must not depend on its only current caller having validated.
  assertSafePath(path);
  let current: JsonObject | unknown[] = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const segment = path[i];
    const nextSegment = path[i + 1];
    /* v8 ignore next -- defensive: sparse-array paths are never produced by callers */
    if (segment === undefined) throw new Error('Invalid empty JSON path segment');
    const nextContainer = typeof nextSegment === 'number' ? [] : {};

    if (typeof segment === 'number') {
      if (!Array.isArray(current))
        throw new Error(`Cannot traverse numeric segment ${segment} on non-array parent`);
      if (!isJsonObject(current[segment]) && !Array.isArray(current[segment]))
        current[segment] = nextContainer;
      current = current[segment] as JsonObject | unknown[];
    } else {
      if (!isJsonObject(current))
        throw new Error(`Cannot traverse property ${segment} on non-object parent`);
      if (!isJsonObject(current[segment]) && !Array.isArray(current[segment]))
        current[segment] = nextContainer;
      current = current[segment] as JsonObject | unknown[];
    }
  }
  return current;
}
