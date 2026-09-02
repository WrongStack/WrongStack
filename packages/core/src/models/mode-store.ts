import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '../utils/atomic-write.js';
import type { Mode, ModeConfig, ModeManifest, ModeStore } from '../types/mode.js';
import { DEFAULT_MODES } from '../types/mode.js';

export class DefaultModeStore implements ModeStore {
  private activeModeId: string | null = null;
  private modes: Mode[];
  private configDir: string;

  constructor(config: ModeConfig) {
    this.configDir = config.directory;
    this.modes = [...DEFAULT_MODES];
  }

  async getActiveMode(): Promise<Mode | null> {
    if (!this.activeModeId) {
      await this.loadActiveMode();
    }
    if (!this.activeModeId) return null;
    return this.modes.find((m) => m.id === this.activeModeId) ?? null;
  }

  async setActiveMode(modeId: string | null): Promise<void> {
    this.activeModeId = modeId;
    await this.saveActiveMode();
  }

  async listModes(): Promise<Mode[]> {
    return [...this.modes];
  }

  async getMode(modeId: string): Promise<Mode | null> {
    return this.modes.find((m) => m.id === modeId) ?? null;
  }

  async addMode(mode: Mode): Promise<void> {
    const idx = this.modes.findIndex((m) => m.id === mode.id);
    if (idx >= 0) {
      this.modes[idx] = mode;
    } else {
      this.modes.push(mode);
    }
  }

  async removeMode(modeId: string): Promise<void> {
    const builtIn = DEFAULT_MODES.find((m) => m.id === modeId);
    if (builtIn) {
      throw new Error(`Cannot remove built-in mode "${modeId}"`);
    }
    this.modes = this.modes.filter((m) => m.id !== modeId);
    if (this.activeModeId === modeId) {
      this.activeModeId = null;
      await this.saveActiveMode();
    }
  }

  private async loadActiveMode(): Promise<void> {
    try {
      const configPath = path.join(this.configDir, 'mode.json');
      const content = await fs.readFile(configPath, 'utf8');
      const data = JSON.parse(content);
      this.activeModeId = data.activeMode ?? null;
    } catch {
      this.activeModeId = 'default';
    }
  }

  private async saveActiveMode(): Promise<void> {
    try {
      await fs.mkdir(this.configDir, { recursive: true });
      const configPath = path.join(this.configDir, 'mode.json');
      // atomicWrite: torn write would leave mode.json malformed and the
      // next load would silently reset to "default".
      await atomicWrite(configPath, JSON.stringify({ activeMode: this.activeModeId }, null, 2));
    } catch {
      // ignore save errors
    }
  }
}

export interface ModeLoaderOptions {
  projectModesDir?: string | undefined;
  userModesDir?: string | undefined;
}

export async function loadProjectModes(modesDir: string): Promise<Mode[]> {
  const modes: Mode[] = [];
  try {
    const entries = await fs.readdir(modesDir);
    for (const entry of entries) {
      if (!entry.endsWith('.md') && !entry.endsWith('.txt')) continue;
      const filePath = path.join(modesDir, entry);
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;
      const content = await fs.readFile(filePath, 'utf8');
      const id = path.basename(entry, path.extname(entry));
      modes.push({
        id,
        name: id.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        description: content.split('\n')[0] ?? id,
        prompt: content,
        tags: ['project'],
      });
    }
  } catch {
    // no project modes
  }
  return modes;
}

export async function loadUserModes(modesDir: string): Promise<Mode[]> {
  const modes: Mode[] = [];
  try {
    const manifestPath = path.join(modesDir, 'modes.json');
    const content = await fs.readFile(manifestPath, 'utf8');
    const manifest: ModeManifest = JSON.parse(content);
    for (const mode of manifest.modes) {
      modes.push(mode);
    }
  } catch {
    // no user modes
  }
  return modes;
}
