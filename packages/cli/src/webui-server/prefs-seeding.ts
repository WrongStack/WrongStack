import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ModelBlackoutRule } from '@wrongstack/core/models';
import { DefaultSecretVault } from '@wrongstack/core/security';
import type { Config } from '@wrongstack/core/types';
import {
  type ConfigWriteLockHolder,
  PREF_KEYS,
  persistPrefsToConfig,
  seedContextMeta,
  prefSnapshot as snapshotPrefs,
} from '@wrongstack/webui-server';

interface CliWebUIOptions {
  agent: { ctx: { meta: Record<string, unknown> } };
  globalConfigPath?: string | undefined;
  profileConfigPath: string;
  appConfig?:
    | {
        fallbackModels?: string[] | undefined;
        fallbackProfiles?: Record<string, string[]> | undefined;
        favoriteModels?: string[] | undefined;
        favoriteModelsOnly?: boolean | undefined;
        modelAvailabilitySchedule?: ModelBlackoutRule[] | undefined;
        fallbackAuto?: boolean | undefined;
        modelMatrix?: Config['modelMatrix'] | undefined;
        uiLocale?: string | undefined;
        /** WrongProxy / WrongTrace toggle. */
        wrongProxyEnabled?: boolean | undefined;
        /** WrongProxy / WrongTrace URL. Default: 'http://localhost:8000'. */
        wrongProxyUrl?: string | undefined;
      }
    | undefined;
}

type PrefSnapshot = Record<string, unknown>;

export { PREF_KEYS };

export async function seedConfigToMeta(opts: CliWebUIOptions): Promise<void> {
  let config = opts.appConfig as Config | undefined;
  if (!config || Object.keys(config).length === 0) {
    if (!opts.profileConfigPath) return;
    try {
      config = JSON.parse(await fs.readFile(opts.profileConfigPath, 'utf8')) as Config;
    } catch {
      return;
    }
  }
  seedContextMeta(config, { meta: opts.agent.ctx.meta });
}

export interface PrefsSeeding {
  prefSnapshot: () => PrefSnapshot;
  persistPrefs: (payload: PrefSnapshot) => Promise<void>;
}

export function createPrefsSeeding(opts: CliWebUIOptions): PrefsSeeding {
  const writeLock: ConfigWriteLockHolder = { lock: Promise.resolve() };

  const patchLiveAppConfig = (patch: NonNullable<CliWebUIOptions['appConfig']>): void => {
    if (!opts.appConfig) return;
    opts.appConfig = { ...opts.appConfig, ...patch };
  };

  const persistPrefs = async (payload: PrefSnapshot): Promise<void> => {
    if (Array.isArray(payload['fallbackModels'])) {
      patchLiveAppConfig({ fallbackModels: payload['fallbackModels'] as string[] });
    }
    if (
      payload['fallbackProfiles'] &&
      typeof payload['fallbackProfiles'] === 'object' &&
      !Array.isArray(payload['fallbackProfiles'])
    ) {
      patchLiveAppConfig({
        fallbackProfiles: payload['fallbackProfiles'] as Record<string, string[]>,
      });
    }
    if (Array.isArray(payload['favoriteModels'])) {
      patchLiveAppConfig({ favoriteModels: payload['favoriteModels'] as string[] });
    }
    if (typeof payload['favoriteModelsOnly'] === 'boolean') {
      patchLiveAppConfig({ favoriteModelsOnly: payload['favoriteModelsOnly'] });
    }
    if (Array.isArray(payload['modelAvailabilitySchedule'])) {
      patchLiveAppConfig({
        modelAvailabilitySchedule: payload['modelAvailabilitySchedule'] as ModelBlackoutRule[],
      });
    }
    if (typeof payload['fallbackAuto'] === 'boolean') {
      patchLiveAppConfig({ fallbackAuto: payload['fallbackAuto'] });
    }
    if (typeof payload['uiLocale'] === 'string') {
      patchLiveAppConfig({ uiLocale: payload['uiLocale'] });
    }
    if (typeof payload['wrongProxyEnabled'] === 'boolean') {
      patchLiveAppConfig({ wrongProxyEnabled: payload['wrongProxyEnabled'] });
    }
    if (typeof payload['wrongProxyUrl'] === 'string') {
      patchLiveAppConfig({ wrongProxyUrl: payload['wrongProxyUrl'] });
    }
    if (
      payload['modelMatrix'] &&
      typeof payload['modelMatrix'] === 'object' &&
      !Array.isArray(payload['modelMatrix'])
    ) {
      patchLiveAppConfig({ modelMatrix: payload['modelMatrix'] as Config['modelMatrix'] });
    }
    if (!opts.profileConfigPath) return;

    const globalRoot = opts.globalConfigPath
      ? path.dirname(opts.globalConfigPath)
      : path.dirname(opts.profileConfigPath);
    const vault = new DefaultSecretVault({ keyFile: path.join(globalRoot, '.key') });
    await persistPrefsToConfig(
      {
        profileConfigPath: opts.profileConfigPath,
        vault,
        logger: {
          warn(message) {
            console.error(
              JSON.stringify({
                level: 'warn',
                event: 'webui.prefs.persist_failed',
                message,
                timestamp: new Date().toISOString(),
              }),
            );
          },
        },
      },
      writeLock,
      payload,
    );
  };

  return {
    prefSnapshot: () => snapshotPrefs(opts.agent.ctx.meta),
    persistPrefs,
  };
}
