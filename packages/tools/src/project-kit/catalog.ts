import { createHash } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { JSONSchema } from '@wrongstack/contracts/types';
import { assertValue, checkSchema, withDefaults } from './schema.js';

export const KIT_DIRECTORY = '.wrongstack/project-kit';
export const KIT_HISTORY_DIRECTORY = '.wrongstack/project-kit-runs';
export const KIT_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const MAX_BYTES = 2 * 1024 * 1024;
export interface KitManifest {
  formatVersion: 1;
  name: string;
  description: string;
  entry: string;
  guide: string;
  effects: 'read' | 'write' | 'external';
  timeoutMs: number;
  inputSchema: JSONSchema;
  outputSchema: JSONSchema;
  tests: Array<{ name: string; input: unknown; expected: unknown }>;
}
export interface KitBundle {
  manifest: KitManifest;
  revision: string;
  files: Map<string, Buffer>;
}

export function assertKitId(name: string): void {
  if (typeof name !== 'string' || name.length > 80 || !KIT_ID.test(name))
    throw new Error('Invalid Project Kit name; use lowercase letters, digits, dots and hyphens');
}

/** Every path component is checked; repository symlinks cannot redirect stores. */
export async function kitPath(root: string, relative: string, create = false): Promise<string> {
  const base = await realpath(root);
  const parts = relative.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.includes('\\') || p.includes(':')))
    throw new Error('Invalid Project Kit path');
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    if (create)
      await mkdir(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error('Project Kit paths must not contain symlinks');
  }
  return current;
}

function parseManifest(raw: Buffer, name: string): KitManifest {
  const m = JSON.parse(raw.toString('utf8')) as KitManifest;
  if (!m || typeof m !== 'object' || m.formatVersion !== 1 || m.name !== name)
    throw new Error('Manifest formatVersion/name mismatch');
  if (typeof m.description !== 'string' || !m.description.trim() || m.description.length > 2048)
    throw new Error('Manifest description required (maximum 2048 characters)');
  if (typeof m.guide !== 'string' || !m.guide.trim() || m.guide.length > 16000)
    throw new Error('Manifest guide required (maximum 16000 characters)');
  if (typeof m.entry !== 'string' || !/^[a-zA-Z0-9_-]+\.mjs$/.test(m.entry))
    throw new Error('Entry must be a top-level .mjs file');
  if (!['read', 'write', 'external'].includes(m.effects))
    throw new Error('Manifest effects must be read, write or external');
  if (!Number.isInteger(m.timeoutMs) || m.timeoutMs < 100 || m.timeoutMs > 600000)
    throw new Error('timeoutMs must be 100..600000');
  checkSchema(m.inputSchema, 'inputSchema');
  if (m.inputSchema.type !== 'object') throw new Error('inputSchema must describe an object');
  checkSchema(m.outputSchema, 'outputSchema');
  if (!Array.isArray(m.tests) || !m.tests.length || m.tests.length > 32)
    throw new Error('Provide 1..32 verification cases');
  for (const test of m.tests) {
    if (!test || typeof test.name !== 'string' || !test.name.trim())
      throw new Error('Every verification case needs a name');
    assertValue(withDefaults(test.input, m.inputSchema), m.inputSchema, 'test input');
    assertValue(test.expected, m.outputSchema, 'test expected');
  }
  return m;
}

export async function loadKit(root: string, name: string): Promise<KitBundle> {
  assertKitId(name);
  const directory = await kitPath(root, `${KIT_DIRECTORY}/${name}`);
  const files = new Map<string, Buffer>();
  let bytes = 0;
  let entryCount = 0;
  async function visit(dir: string, prefix = '', depth = 0): Promise<void> {
    if (depth > 8) throw new Error('Project Kit exceeds directory depth 8');
    const entries = await readdir(dir, { withFileTypes: true });
    entryCount += entries.length;
    if (entryCount > 256) throw new Error('Project Kit exceeds 256 total directory entries');
    if (entries.length > 128) throw new Error('Project Kit exceeds 128 entries per directory');
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = prefix + entry.name;
      const target = path.join(dir, entry.name);
      const stat = await lstat(target);
      if (stat.isSymbolicLink()) throw new Error('Project Kit bundles must not contain symlinks');
      if (stat.isDirectory()) await visit(target, `${relative}/`, depth + 1);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > MAX_BYTES || files.size >= 128)
          throw new Error('Project Kit exceeds 2 MiB or 128 files');
        const body = await readFile(target);
        if (body.length !== stat.size) throw new Error('Project Kit changed while reading; retry');
        files.set(relative, body);
      } else throw new Error('Project Kit supports regular files only');
    }
  }
  await visit(directory);
  const raw = files.get('kit.json');
  if (!raw) throw new Error('Missing kit.json');
  const manifest = parseManifest(raw, name);
  if (!files.has(manifest.entry)) throw new Error('Missing entry module');
  const hash = createHash('sha256');
  for (const [file, content] of files)
    hash.update(JSON.stringify([file, content.length])).update(content);
  return { manifest, files, revision: hash.digest('hex') };
}

export async function listKits(root: string, query = '') {
  let directory: string;
  try {
    directory = await kitPath(root, KIT_DIRECTORY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { tools: [], invalid: [] };
    throw error;
  }
  const entries = await readdir(directory, { withFileTypes: true });
  if (entries.length > 256) throw new Error('Project Kit catalog exceeds 256 entries');
  const tools: Array<{ name: string; description: string; effects: string; revision: string }> = [];
  const invalid: Array<{ name: string; error: string }> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    try {
      const { manifest: m, revision } = await loadKit(root, entry.name);
      if (`${m.name} ${m.description}`.toLowerCase().includes(query.toLowerCase()))
        tools.push({ name: m.name, description: m.description, effects: m.effects, revision });
    } catch (error) {
      invalid.push({ name: entry.name, error: (error as Error).message });
    }
  }
  return { tools, invalid };
}

/** Cheap advisory discovery: manifests only, never module imports or source hashes.
 * Oversized/invalid manifests are omitted here; the normal catalog still reports
 * them. A suggestion is not a claim that the full source bundle is executable.
 */
export async function readKitAdviceCatalog(root: string, signal: AbortSignal) {
  let directory: string;
  try {
    directory = await kitPath(root, KIT_DIRECTORY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const entries = await readdir(directory, { withFileTypes: true });
  const summaries: Array<Pick<KitManifest, 'name' | 'description' | 'effects'>> = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en')).slice(0, 256)) {
    signal.throwIfAborted();
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      entry.name.length > 80 ||
      !KIT_ID.test(entry.name)
    )
      continue;
    try {
      const target = await kitPath(root, `${KIT_DIRECTORY}/${entry.name}/kit.json`);
      const stat = await lstat(target);
      if (!stat.isFile() || stat.size > 65536) continue;
      const handle = await open(target, 'r');
      let raw: Buffer;
      try {
        const buffer = Buffer.alloc(65537);
        let count = 0;
        while (count < buffer.length) {
          signal.throwIfAborted();
          const { bytesRead } = await handle.read(buffer, count, buffer.length - count, count);
          if (!bytesRead) break;
          count += bytesRead;
        }
        raw = buffer.subarray(0, count);
      } finally {
        await handle.close();
      }
      signal.throwIfAborted();
      if (raw.length > 65536) continue;
      const manifest = parseManifest(raw, entry.name);
      summaries.push({
        name: manifest.name,
        description: manifest.description,
        effects: manifest.effects,
      });
    } catch {
      signal.throwIfAborted();
      // One broken kit must not hide the others or interrupt the task.
    }
  }
  return summaries;
}
