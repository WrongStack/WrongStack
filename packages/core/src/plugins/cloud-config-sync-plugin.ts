import * as path from 'node:path';
// Types come from their source modules, not '../index.js' — the barrel would put this
// file into the ARCH-CYCLE-TYPE-14 module cycle.
import type { Context } from '../core/context.js';
import { decryptConfigSecrets, encryptConfigSecrets } from '../security/config-secrets.js';
import { CloudConfigSync } from '../storage/cloud-config-sync.js';
import type { CloudSyncConfig, ConfigStore } from '../types/config.js';
import type { Plugin } from '../types/plugin.js';
import type { SecretVault } from '../types/secret-vault.js';
import type { SlashCommand } from '../types/slash-command.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { readJsonObjectFile } from '../utils/config-json.js';
import { toErrorMessage } from '../utils/error.js';
import type { WstackPaths } from '../utils/wstack-paths.js';

interface CloudConfigSyncPluginOptions {
  paths?: WstackPaths | undefined;
  configStore?: ConfigStore | undefined;
  vault?: SecretVault | undefined;
  appVersion?: string | undefined;
}

const DEFAULT_INTERVAL_SECONDS = 300;
const MIN_INTERVAL_SECONDS = 60;

/**
 * CloudConfigSyncPlugin — background config synchronization with my.wrongstack.com.
 *
 * Registers `/cloudsync` and, while enabled, runs a pull-then-push pass every
 * `cloudSync.intervalSeconds` (default 300). Distinct from `wstack-sync` (the legacy
 * GitHub category sync): this speaks the portal's namespaced, schema-validated,
 * secret-free sync API v1 and never uploads credential material — the sanitizer in
 * `storage/cloud-config-sync/sanitize.ts` is the client half of the server's contract.
 */
export function createCloudConfigSyncPlugin(opts?: CloudConfigSyncPluginOptions): Plugin {
  let engine: CloudConfigSync | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let passRunning = false;

  return {
    name: 'wstack-cloud-config-sync',
    version: '1.0.0',
    description: 'my.wrongstack.com config synchronization (namespaced sync API v1)',
    apiVersion: '^0.1',
    capabilities: { slashCommands: true },
    defaultConfig: {},

    setup(api) {
      const rawConfig = api.config as never as Record<string, unknown>;
      const paths = opts?.paths ?? (rawConfig.paths as WstackPaths | undefined);
      const configStore = opts?.configStore ?? (rawConfig.configStore as ConfigStore | undefined);
      const vault = opts?.vault ?? (rawConfig.vault as SecretVault | undefined);
      const appVersion = opts?.appVersion ?? (rawConfig.appVersion as string | undefined);

      if (!paths?.configDir || !configStore || !vault) {
        api.log.warn(
          '[cloud-config-sync] paths, configStore, or vault not available — /cloudsync disabled',
        );
        return;
      }

      const profileConfigPath = path.join(paths.configDir, 'config.json');
      const statePath = path.join(paths.configDir, 'cloud-sync-state.json');
      const warn = (msg: string) => api.log.warn(msg);

      const readLocalConfig = async (): Promise<Record<string, unknown>> => {
        const raw = await readJsonObjectFile(profileConfigPath).catch(() => ({}));
        return decryptConfigSecrets(raw as Record<string, unknown>, vault, { warn });
      };

      const writeLocalConfig = async (
        mutator: (config: Record<string, unknown>) => Record<string, unknown>,
      ): Promise<void> => {
        const current = await readLocalConfig();
        const next = mutator(current);
        const encrypted = encryptConfigSecrets(next, vault);
        await atomicWrite(profileConfigPath, `${JSON.stringify(encrypted, null, 2)}\n`, {
          mode: 0o600,
        });
        // Keep the in-memory store coherent for the parts it holds.
        configStore.update({ cloudSync: next.cloudSync } as Parameters<ConfigStore['update']>[0]);
      };

      const getSettings = () => {
        const cfg = (configStore.get() as Record<string, unknown>).cloudSync as
          | CloudSyncConfig
          | undefined;
        if (!cfg?.enabled || !cfg.url || !cfg.token) return null;
        const token =
          cfg.token.startsWith('enc:') && vault.decrypt ? vault.decrypt(cfg.token) : cfg.token;
        return { enabled: true, url: cfg.url, token };
      };

      engine = new CloudConfigSync({
        statePath,
        readLocalConfig,
        writeLocalConfig,
        getSettings,
        appVersion,
        logger: { info: (m) => api.log.info(m), warn },
      });

      const runPass = async (): Promise<string> => {
        if (!engine) return 'Cloud config sync is not initialized.';
        if (passRunning) return 'A sync pass is already running.';
        passRunning = true;
        try {
          const result = await engine.syncOnce();
          return result.message;
        } finally {
          passRunning = false;
        }
      };

      const scheduleLoop = () => {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        const cfg = (configStore.get() as Record<string, unknown>).cloudSync as
          | CloudSyncConfig
          | undefined;
        if (!cfg?.enabled) return;
        const seconds = Math.max(
          MIN_INTERVAL_SECONDS,
          cfg.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS,
        );
        timer = setInterval(() => {
          void runPass().catch((err) => warn(`[cloud-config-sync] ${toErrorMessage(err)}`));
        }, seconds * 1000);
        timer.unref?.();
      };

      const setCloudSyncConfig = async (patch: Partial<CloudSyncConfig>): Promise<void> => {
        await writeLocalConfig((config) => ({
          ...config,
          cloudSync: { ...(config.cloudSync as CloudSyncConfig | undefined), ...patch },
        }));
        scheduleLoop();
      };

      api.slashCommands.register(
        buildCloudSyncCommand(engine, configStore, setCloudSyncConfig, runPass),
      );
      scheduleLoop();
      api.log.info('[cloud-config-sync] loaded — /cloudsync available.');
    },

    teardown(api) {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      api.slashCommands.unregister('cloudsync');
      api.log.info('[cloud-config-sync] unloaded');
    },

    async health() {
      return { ok: true, message: 'CloudConfigSync ready' };
    },
  };
}

function buildCloudSyncCommand(
  engine: CloudConfigSync,
  configStore: ConfigStore,
  setCloudSyncConfig: (patch: Partial<CloudSyncConfig>) => Promise<void>,
  runPass: () => Promise<string>,
): SlashCommand {
  return {
    name: 'cloudsync',
    description: 'Portal config sync: /cloudsync [status|on|off|now|set url|set token]',
    async run(args: string, _ctx: Context) {
      const [verb, ...rest] = args.trim().split(/\s+/);
      const restJoined = rest.join(' ').trim();

      switch (verb) {
        case '':
        case 'status':
          return { message: await engine.statusText() };

        case 'on': {
          const cfg = (configStore.get() as Record<string, unknown>).cloudSync as
            | CloudSyncConfig
            | undefined;
          if (!cfg?.url || !cfg.token) {
            return {
              message: [
                'Set the portal first:',
                '  /cloudsync set url https://my.wrongstack.com',
                '  /cloudsync set token wst_…   (from the dashboard "Connect client" flow)',
              ].join('\n'),
            };
          }
          await setCloudSyncConfig({ enabled: true });
          const first = await runPass();
          return { message: `Cloud config sync enabled.\n${first}` };
        }

        case 'off': {
          await setCloudSyncConfig({ enabled: false });
          return { message: 'Cloud config sync disabled. Local config kept as-is.' };
        }

        case 'now': {
          try {
            return { message: await runPass() };
          } catch (err) {
            return { message: `Sync failed: ${toErrorMessage(err)}` };
          }
        }

        case 'set': {
          const [field, ...valueParts] = restJoined.split(/\s+/);
          const value = valueParts.join(' ').trim();
          if (field === 'url') {
            if (!/^https?:\/\//.test(value)) {
              return { message: 'Usage: /cloudsync set url https://my.wrongstack.com' };
            }
            await setCloudSyncConfig({ url: value.replace(/\/+$/, '') });
            return { message: `Portal URL set to ${value}.` };
          }
          if (field === 'token') {
            if (!/^wst_[A-Za-z0-9_-]{43}$/.test(value)) {
              return {
                message:
                  'That does not look like a machine token (wst_ + 43 chars). Create one in the dashboard "Connect client" flow.',
              };
            }
            // Plaintext only in memory; the config writer encrypts `token` by field name
            // before it reaches disk.
            await setCloudSyncConfig({ token: value });
            return { message: 'Machine token stored (encrypted at rest).' };
          }
          if (field === 'interval') {
            const seconds = Number.parseInt(value, 10);
            if (!Number.isFinite(seconds) || seconds < MIN_INTERVAL_SECONDS) {
              return {
                message: `Usage: /cloudsync set interval <seconds ≥ ${MIN_INTERVAL_SECONDS}>`,
              };
            }
            await setCloudSyncConfig({ intervalSeconds: seconds });
            return { message: `Sync interval set to ${seconds}s.` };
          }
          return { message: 'Usage: /cloudsync set url|token|interval <value>' };
        }

        default:
          return {
            message: [
              '/cloudsync — my.wrongstack.com config sync',
              '',
              '  /cloudsync status              Show sync state',
              '  /cloudsync set url <url>       Set the portal URL',
              '  /cloudsync set token <wst_…>   Store the machine token (encrypted)',
              '  /cloudsync set interval <sec>  Background pass interval',
              '  /cloudsync on                  Enable + run the first pass',
              '  /cloudsync off                 Disable background sync',
              '  /cloudsync now                 Run one pass immediately',
              '',
              'Secrets never sync: providers keys, hq binding, and bot tokens stay local.',
            ].join('\n'),
          };
      }
    },
  };
}
