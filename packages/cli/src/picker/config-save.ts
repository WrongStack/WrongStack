import os from 'node:os';
import { toErrorMessage } from '@wrongstack/core/utils';
import { appendHistory, backupCurrent } from '../config-history.js';

export async function saveToGlobalConfig(
  configPath: string,
  provider: string,
  model: string,
  homeFn: () => string = () => process.env.HOME ?? os.homedir(),
): Promise<boolean> {
  try {
    const { atomicWrite } = await import('@wrongstack/core/utils');
    const fs = await import('node:fs/promises');

    let existing: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(configPath, 'utf8');
      existing = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // No existing config
    }

    const oldCfg = { ...existing };
    existing.provider = provider;
    existing.model = model;

    try {
      await backupCurrent(homeFn, configPath);
    } catch (err) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'picker.backup_failed',
          message: toErrorMessage(err),
          timestamp: new Date().toISOString(),
        }),
      );
    }

    await atomicWrite(configPath, JSON.stringify(existing, null, 2), { mode: 0o600 });

    try {
      await appendHistory(
        oldCfg,
        existing,
        `Provider/model changed: ${oldCfg.provider ?? '(none)'} → ${provider}, ${oldCfg.model ?? '(none)'} → ${model}`,
        homeFn,
        configPath,
      );
    } catch {
      // best-effort
    }

    return true;
  } catch (err) {
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'picker.save_failed',
        message: toErrorMessage(err),
        timestamp: new Date().toISOString(),
      }),
    );
    return false;
  }
}
