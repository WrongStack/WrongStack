import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type {
  InstalledPromptEntry,
  PromptManifestData,
} from '@wrongstack/contracts/types/prompt-registry';
import { atomicWrite, ensureDir } from '../utils/atomic-write.js';

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
      const raw = JSON.parse(await fs.readFile(this.manifestPath, 'utf8'));
      if (raw && typeof raw === 'object' && Array.isArray(raw.entries)) {
        return { version: 1, entries: raw.entries as InstalledPromptEntry[] };
      }
    } catch {
      // missing or corrupt → start empty
    }
    return { version: 1, entries: [] };
  }

  async save(data: PromptManifestData): Promise<void> {
    await ensureDir(path.dirname(this.manifestPath));
    await atomicWrite(this.manifestPath, JSON.stringify(data, null, 2));
  }

  /** Upsert one entry keyed by slug. */
  async record(entry: InstalledPromptEntry): Promise<void> {
    const data = await this.load();
    const idx = data.entries.findIndex((e) => e.slug === entry.slug);
    if (idx === -1) data.entries.push(entry);
    else data.entries[idx] = entry;
    await this.save(data);
  }

  async remove(slug: string): Promise<boolean> {
    const data = await this.load();
    const next = data.entries.filter((e) => e.slug !== slug);
    if (next.length === data.entries.length) return false;
    await this.save({ version: 1, entries: next });
    return true;
  }

  async list(): Promise<InstalledPromptEntry[]> {
    return (await this.load()).entries;
  }
}
