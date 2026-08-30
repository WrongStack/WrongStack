import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { PromptEntry, PromptVariable } from '../types/prompt.js';
import { atomicWrite, ensureDir } from '../utils/atomic-write.js';
import { slugify } from '../utils/slug.js';
import { ulid } from '../utils/ulid.js';
import type { WstackPaths } from '../utils/wstack-paths.js';

export type { PromptEntry, PromptSource, PromptVariable } from '../types/prompt.js';

export interface PromptStore {
  list(): Promise<PromptEntry[]>;
  get(id: string): Promise<PromptEntry | null>;
  save(entry: PromptEntry): Promise<void>;
  delete(id: string): Promise<boolean>;
  find(query: string): Promise<PromptEntry[]>;
}

/** Current on-disk schema version. */
const SCHEMA_VERSION = 2;

interface RawPromptFile {
  version: number;
  entry: unknown;
}

/** sha256 of a prompt's content — used for builtin/synced integrity checks. */
export function promptChecksum(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Upgrade any persisted prompt record (v1 or v2) to a fully-populated v2
 * `PromptEntry`. Pure — does not touch disk. v1 records (only
 * `id/title/content/tags/createdAt/updatedAt`) get sensible defaults:
 * slug from title, empty description, `uncategorized` category, `user` source.
 */
export function migratePromptEntry(raw: unknown): PromptEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['id'] !== 'string' || typeof r['title'] !== 'string') return null;

  const title = r['title'];
  const content = typeof r['content'] === 'string' ? r['content'] : '';
  const now = typeof r['createdAt'] === 'string' ? r['createdAt'] : new Date(0).toISOString();
  const tags = Array.isArray(r['tags'])
    ? (r['tags'].filter((t) => typeof t === 'string') as string[])
    : [];

  return {
    id: r['id'],
    slug: typeof r['slug'] === 'string' && r['slug'].length > 0 ? r['slug'] : slugify(title),
    title,
    description: typeof r['description'] === 'string' ? r['description'] : '',
    content,
    category:
      typeof r['category'] === 'string' && r['category'].length > 0
        ? r['category']
        : 'uncategorized',
    tags,
    source: isPromptSource(r['source']) ? r['source'] : 'user',
    favorite: r['favorite'] === true,
    variables: normalizeVariables(r['variables']),
    author: typeof r['author'] === 'string' ? r['author'] : undefined,
    version: typeof r['version'] === 'string' ? r['version'] : undefined,
    license: typeof r['license'] === 'string' ? r['license'] : undefined,
    checksum: typeof r['checksum'] === 'string' ? r['checksum'] : undefined,
    forkedFrom: typeof r['forkedFrom'] === 'string' ? r['forkedFrom'] : undefined,
    createdAt: now,
    updatedAt: typeof r['updatedAt'] === 'string' ? r['updatedAt'] : now,
  };
}

function isPromptSource(v: unknown): v is PromptEntry['source'] {
  return v === 'builtin' || v === 'user' || v === 'project' || v === 'synced';
}

function normalizeVariables(v: unknown): PromptVariable[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: PromptVariable[] = [];
  for (const item of v) {
    if (
      item &&
      typeof item === 'object' &&
      typeof (item as Record<string, unknown>)['name'] === 'string'
    ) {
      const o = item as Record<string, unknown>;
      const enumVals =
        Array.isArray(o['enum']) && o['enum'].every((x) => typeof x === 'string')
          ? (o['enum'] as string[])
          : undefined;
      out.push({
        name: o['name'] as string,
        description: typeof o['description'] === 'string' ? o['description'] : undefined,
        default: typeof o['default'] === 'string' ? o['default'] : undefined,
        required: o['required'] === true ? true : undefined,
        enum: enumVals && enumVals.length > 0 ? enumVals : undefined,
        multiline: o['multiline'] === true ? true : undefined,
      });
    }
  }
  return out.length > 0 ? out : undefined;
}

/**
 * DefaultPromptStore — file-per-prompt JSON in a single directory (the global
 * the active profile's `prompts` directory by default, or a layer dir the loader passes in).
 * Reads tolerate legacy v1 files via `migratePromptEntry`; writes always emit
 * the current v2 schema.
 */
export class DefaultPromptStore implements PromptStore {
  private readonly dir: string;

  constructor(pathsOrDir: WstackPaths | string) {
    this.dir = typeof pathsOrDir === 'string' ? pathsOrDir : pathsOrDir.globalPrompts;
  }

  async list(): Promise<PromptEntry[]> {
    await ensureDir(this.dir);
    const entries: PromptEntry[] = [];
    try {
      const files = await fs.readdir(this.dir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw: RawPromptFile = JSON.parse(
            await fs.readFile(path.join(this.dir, file), 'utf8'),
          );
          const migrated = migratePromptEntry(raw.entry);
          if (migrated) entries.push(migrated);
        } catch {
          // skip corrupt files
        }
      }
    } catch {
      // dir doesn't exist yet
    }
    return entries.sort(
      (a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0),
    );
  }

  async get(id: string): Promise<PromptEntry | null> {
    const file = path.join(this.dir, `${id}.json`);
    try {
      const raw: RawPromptFile = JSON.parse(await fs.readFile(file, 'utf8'));
      return migratePromptEntry(raw.entry);
    } catch {
      return null;
    }
  }

  async save(entry: PromptEntry): Promise<void> {
    await ensureDir(this.dir);
    const file = path.join(this.dir, `${entry.id}.json`);
    const raw: RawPromptFile = { version: SCHEMA_VERSION, entry };
    await atomicWrite(file, JSON.stringify(raw, null, 2));
  }

  async delete(id: string): Promise<boolean> {
    const file = path.join(this.dir, `${id}.json`);
    try {
      await fs.unlink(file);
      return true;
    } catch {
      return false;
    }
  }

  async find(query: string): Promise<PromptEntry[]> {
    const all = await this.list();
    const lower = query.toLowerCase();
    return all.filter(
      (e) =>
        e.title.toLowerCase().includes(lower) ||
        e.description.toLowerCase().includes(lower) ||
        e.content.toLowerCase().includes(lower) ||
        e.category.toLowerCase().includes(lower) ||
        e.tags.some((t) => t.toLowerCase().includes(lower)),
    );
  }

  /** Create a new v2 entry and return it. Does NOT persist — call save() afterwards. */
  createNew(
    title: string,
    content: string,
    tags: string[] = [],
    extra: Partial<
      Omit<PromptEntry, 'id' | 'title' | 'content' | 'tags' | 'createdAt' | 'updatedAt'>
    > = {},
  ): PromptEntry {
    const now = new Date().toISOString();
    return {
      id: ulid(),
      slug: extra.slug && extra.slug.length > 0 ? extra.slug : slugify(title),
      title,
      description: extra.description ?? '',
      content,
      category: extra.category ?? 'uncategorized',
      tags,
      source: extra.source ?? 'user',
      favorite: extra.favorite ?? false,
      variables: extra.variables,
      author: extra.author,
      version: extra.version,
      license: extra.license,
      checksum: extra.checksum,
      forkedFrom: extra.forkedFrom,
      createdAt: now,
      updatedAt: now,
    };
  }
}
