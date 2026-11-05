import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  InstalledPromptEntry,
  PromptManifestData,
} from '@wrongstack/contracts/types/prompt-registry';
import { atomicWrite, ensureDir, withFileLock } from '../utils/atomic-write.js';

/**
 * Tracks prompts pulled from a remote registry, persisted to
 * `<profile>/installed-prompts.json`. Mirrors `SkillManifestStore`. The
 * manifest is the source of truth for "what have I synced and at what version",
 * enabling a future `pull --favorites` / update flow.
 */
export class PromptManifestStore {
  constructor(private readonly manifestPath: string) {}

  async load(): Promise<PromptManifestData> {
    try {
      // Same BOM rule as readForUpdate(): an editor-written UTF-8 BOM must not
      // make a valid manifest list as empty while record()/remove() still read it.
      const raw = JSON.parse((await fs.readFile(this.manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
      if (raw && typeof raw === 'object' && Array.isArray(raw.entries)) {
        return { version: 1, entries: raw.entries as InstalledPromptEntry[] };
      }
    } catch {
      // missing or corrupt → start empty
    }
    return { version: 1, entries: [] };
  }

  private async readForUpdate(): Promise<PromptManifestData> {
    let raw: string;
    try {
      raw = await fs.readFile(this.manifestPath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { version: 1, entries: [] };
      }
      throw error;
    }
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as PromptManifestData;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.entries)) {
      throw new Error(`${this.manifestPath} has no entries list; refusing to overwrite it`);
    }
    return { version: 1, entries: parsed.entries as InstalledPromptEntry[] };
  }

  async save(data: PromptManifestData): Promise<void> {
    await ensureDir(path.dirname(this.manifestPath));
    await atomicWrite(this.manifestPath, JSON.stringify(data, null, 2));
  }

  /** Upsert one entry keyed by slug. */
  async record(entry: InstalledPromptEntry): Promise<void> {
    return withFileLock(this.manifestPath, async () => {
      const data = await this.readForUpdate();
      const idx = data.entries.findIndex((e) => e.slug === entry.slug);
      if (idx === -1) data.entries.push(entry);
      else data.entries[idx] = entry;
      await this.save(data);
    });
  }

  async remove(slug: string): Promise<boolean> {
    return withFileLock(this.manifestPath, async () => {
      const data = await this.readForUpdate();
      const next = data.entries.filter((e) => e.slug !== slug);
      if (next.length === data.entries.length) return false;
      await this.save({ version: 1, entries: next });
      return true;
    });
  }

  async list(): Promise<InstalledPromptEntry[]> {
    return (await this.load()).entries;
  }
}
