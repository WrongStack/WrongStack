import * as fs from 'node:fs/promises';
import { type ConfigDefaultRepairReport, repairConfigDefaults } from '@wrongstack/core/storage';
import type { Config, SecretVault } from '@wrongstack/core/types';
import { atomicWrite } from '@wrongstack/core/utils';
import { decryptConfigSecrets } from '@wrongstack/core/security';
import type { WebSocket } from 'ws';
import { send } from './ws-utils.js';

export interface ConfigDoctorDeps {
  profileConfigPath: string;
  vault: SecretVault;
  updateConfig: (
    mutate: (config: Record<string, unknown>) => void,
    errorLabel: string,
  ) => Promise<void>;
  applyRuntimeConfig: (config: Config) => void;
}

async function readConfig(
  file: string,
  vault: SecretVault,
): Promise<{ raw: string; decrypted: Record<string, unknown> }> {
  const raw = await fs.readFile(file, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
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
      const backupSuffix = `.last-${Date.now()}`;
      const backupPath = `${deps.profileConfigPath}${backupSuffix}`;
      await atomicWrite(backupPath, current.raw, { mode: 0o600 });
      await deps.updateConfig((config) => {
        for (const key of Object.keys(config)) delete config[key];
        Object.assign(config, report.fixed);
      }, 'config.doctor');
      deps.applyRuntimeConfig(report.fixed as unknown as Config);

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
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}
