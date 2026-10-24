import * as fs from 'node:fs/promises';
import type { Config, SecretVault } from '@wrongstack/contracts/types';
import { decryptConfigSecrets } from '@wrongstack/core/security';
import { type ConfigDefaultRepairReport, repairConfigDefaults } from '@wrongstack/core/storage';
import { atomicWrite } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
import { errMessage, send } from './ws-utils.js';

export interface ConfigDoctorDeps {
  profileConfigPath: string;
  vault: SecretVault;
  updateConfig: (
    mutate: (config: Record<string, unknown>) => void,
    errorLabel: string,
  ) => Promise<void>;
  applyRuntimeConfig: (config: Config) => void;
}

let lastBackupStamp = 0n;
function nextBackupStamp(): string {
  const clock = BigInt(Date.now()) * 1_000_000n;
  lastBackupStamp = clock > lastBackupStamp ? clock : lastBackupStamp + 1n;
  return lastBackupStamp.toString();
}

async function readConfig(
  file: string,
  vault: SecretVault,
): Promise<{ raw: string; decrypted: Record<string, unknown> }> {
  const raw = await fs.readFile(file, 'utf8');
  // Parse past a UTF-8 BOM (as the config loader does); `raw` stays exact for the backup.
  const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Active profile config must contain a JSON object.');
  }
  return {
    raw,
    decrypted: decryptConfigSecrets(parsed as Record<string, unknown>, vault) as Record<
      string,
      unknown
    >,
  };
}

/** Preview or apply canonical defaults to the active profile config. */
export async function handleConfigDoctor(
  ws: WebSocket,
  apply: boolean,
  deps: ConfigDoctorDeps,
): Promise<void> {
  try {
    const current = await readConfig(deps.profileConfigPath, deps.vault);
    const report: ConfigDefaultRepairReport = repairConfigDefaults(current.decrypted);

    if (apply && report.changed) {
      // Keep the exact encrypted source as a recoverable sibling before the
      // shared config writer decrypts, mutates, re-encrypts, and atomically saves.
      // Use a timestamped suffix so consecutive `/doctor fix` runs don't
      // overwrite prior snapshots (the UI surfaces this path to the user).
      const backupSuffix = `.last-${nextBackupStamp()}`;
      const backupPath = `${deps.profileConfigPath}${backupSuffix}`;
      await atomicWrite(backupPath, current.raw, { mode: 0o600 });
      // Repair the config the writer just read under its lock, not the
      // snapshot above: replacing the file with that stale snapshot erased any
      // write (a TUI key add, a prefs toggle) that landed in between.
      let applied = report.fixed;
      await deps.updateConfig((config) => {
        applied = repairConfigDefaults(config).fixed;
        for (const key of Object.keys(config)) delete config[key];
        Object.assign(config, applied);
      }, 'config.doctor');
      deps.applyRuntimeConfig(applied as unknown as Config);

      send(ws, {
        type: 'config.doctor.result',
        payload: {
          success: true,
          applied: true,
          changed: true,
          changes: report.changes,
          configPath: deps.profileConfigPath,
          backupPath,
        },
      });
    } else {
      send(ws, {
        type: 'config.doctor.result',
        payload: {
          success: true,
          applied: false,
          changed: report.changed,
          changes: report.changes,
          configPath: deps.profileConfigPath,
          backupPath: undefined,
        },
      });
    }
  } catch (err) {
    send(ws, {
      type: 'config.doctor.result',
      payload: {
        success: false,
        applied: false,
        changed: false,
        changes: [],
        configPath: deps.profileConfigPath,
        error: errMessage(err),
      },
    });
  }
}
