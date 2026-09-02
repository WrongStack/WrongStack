import * as path from 'node:path';
import { expectDefined } from '../utils/expect-defined.js';
import { toErrorMessage } from '../utils/error.js';
import type { Plugin } from '../types/plugin.js';
import type { SlashCommand, Context } from '../index.js';
import type { SyncCategory, SyncConfig } from '../types/config.js';
import { CloudSync, ALL_SYNC_CATEGORIES } from '../storage/cloud-sync.js';
import type { WstackPaths } from '../utils/wstack-paths.js';
import type { ConfigStore } from '../types/config.js';
import { atomicWrite } from '../utils/atomic-write.js';
interface SyncPluginOptions {
  paths?: WstackPaths | undefined;
  configStore?: ConfigStore | undefined;
  /** Secret vault for encrypting the GitHub token before persisting to disk. */
  vault?: { encrypt(plaintext: string): string; decrypt?(value: string): string };
}

/**
 * SyncPlugin — GitHub-backed cloud sync for WrongStack user data.
 *
 * Registers `/sync` slash command. Users can push/pull their prompts,
 * skills, settings, memory, and history to a private GitHub repo.
 * Active by default; configure once with `/sync enable owner/repo TOKEN`.
 */
export function createSyncPlugin(opts?: SyncPluginOptions): Plugin {
  let cloud: CloudSync | null = null;
  let configStore: ConfigStore | undefined;
  let vault: { encrypt(plaintext: string): string; decrypt?(value: string): string } | undefined;

  return {
    name: 'wstack-sync',
    version: '1.0.0',
    description: 'GitHub cloud sync for prompts, skills, settings, memory and history',
    apiVersion: '^0.1',
    capabilities: { slashCommands: true },
    defaultConfig: {},

    setup(api) {
      const rawConfig = api.config as never as Record<string, unknown>;
      const paths = opts?.paths ?? (rawConfig.paths as WstackPaths | undefined);
      configStore = opts?.configStore ?? (rawConfig.configStore as ConfigStore | undefined);
      vault = opts?.vault ?? (rawConfig.vault as typeof vault | undefined);

      if (!paths || !configStore || !paths.configDir) {
        api.log.warn('[sync] paths, configStore, or configDir not available — /sync disabled');
        return;
      }
      const syncConfigPath = paths.syncConfig ?? path.join(paths.configDir, 'sync.json');

      cloud = new CloudSync(
        paths,
        () => {
          const cfg = configStore?.get();
          return (cfg as Record<string, unknown>).sync as {
            enabled: boolean;
            repo: string;
            githubToken: string;
            categories: SyncCategory[];
          } | null;
        },
        async (cfg) => {
          await persistSyncConfig(syncConfigPath, cfg, vault);
          configStore?.update({ sync: cfg } as Parameters<ConfigStore['update']>[0]);
        },
        () => path.join(paths.configDir, 'config.json'),
      );

      void cloud.loadState();
      api.slashCommands.register(buildSyncCommand(cloud, configStore, vault, syncConfigPath));
      api.log.info('[sync] loaded — /sync available. Run /sync to get started.');
    },

    teardown(api) {
      api.slashCommands.unregister('sync');
      api.log.info('[sync] unloaded');
    },

    async health() {
      return { ok: true, message: 'CloudSync ready' };
    },
  };
}

async function persistSyncConfig(
  syncConfigPath: string,
  cfg: SyncConfig,
  vault: { encrypt(plaintext: string): string } | undefined,
): Promise<void> {
  let githubToken = cfg.githubToken;
  if (githubToken && !githubToken.startsWith('enc:')) {
    if (!vault) {
      throw new Error(
        'Secure token storage is unavailable; refusing to persist a plaintext token.',
      );
    }
    const encryptedToken = vault.encrypt(githubToken);
    if (encryptedToken === githubToken || !encryptedToken.startsWith('enc:')) {
      throw new Error('Secure token storage failed; refusing to persist a plaintext token.');
    }
    githubToken = encryptedToken;
  }
  await atomicWrite(syncConfigPath, JSON.stringify({ ...cfg, githubToken }, null, 2), {
    mode: 0o600,
  });
}

function buildSyncCommand(
  cloud: CloudSync,
  configStore: ConfigStore,
  vault: { encrypt(plaintext: string): string; decrypt?(value: string): string } | undefined,
  syncConfigPath: string,
): SlashCommand {
  const setSyncConfig = async (cfg: SyncConfig): Promise<void> => {
    await persistSyncConfig(syncConfigPath, cfg, vault);
    configStore.update({ sync: cfg } as Parameters<ConfigStore['update']>[0]);
  };

  return {
    name: 'sync',
    description: 'Cloud sync: /sync [status|enable|disable|push|pull|categories]',
    async run(args: string, _ctx: Context) {
      const [verb, ...rest] = args.trim().split(/\s+/);
      const restJoined = rest.join(' ');

      switch (verb) {
        case '':
        case 'status': {
          const msg = await cloud.status();
          return { message: msg };
        }

        case 'enable': {
          const parts = restJoined.trim().split(/\s+/);
          if (parts.length < 2) {
            return {
              message: [
                'Usage: /sync enable owner/repo TOKEN [cat1 cat2 ...]',
                '  e.g. /sync enable myname/wrongstack-data ghp_xxx',
                `  Categories (default: all): ${ALL_SYNC_CATEGORIES.join(', ')}`,
              ].join('\n'),
            };
          }
          const [repo, token, ...cats] = parts;
          if (!repo?.includes('/')) {
            return { message: 'Invalid repo format. Expected "owner/repo".' };
          }

          if (!vault) {
            return {
              message: 'Secure token storage is unavailable; refusing to enable CloudSync.',
            };
          }
          // Keep plaintext in memory for GitHub requests; persistSyncConfig encrypts
          // the token in sync.json before it reaches disk.
          const invalidCategories = cats.filter(
            (cat) => !ALL_SYNC_CATEGORIES.includes(cat as SyncCategory),
          );
          if (invalidCategories.length > 0) {
            return {
              message: `Unknown categories: ${invalidCategories.join(', ')}. Available: ${ALL_SYNC_CATEGORIES.join(', ')}`,
            };
          }
          const syncConfig: SyncConfig = {
            enabled: true,
            repo,
            githubToken: expectDefined(token),
            categories: cats.length > 0 ? (cats as SyncCategory[]) : ALL_SYNC_CATEGORIES,
            lastSyncedAt: undefined,
          };

          // Persist to the active profile's sync.json (separate from config.json
          // to avoid accidental commits). Use atomicWrite so a crash never
          // produces a half-written token file.
          await setSyncConfig(syncConfig);
          await cloud.loadState();

          return {
            message: [
              `CloudSync enabled for ${repo}`,
              `  categories: ${syncConfig.categories.join(', ')}`,
              '',
              'Run `/sync push` to upload your data to GitHub.',
            ].join('\n'),
          };
        }

        case 'disable': {
          const msg = await cloud.disable();
          return { message: msg };
        }

        case 'push': {
          const cfg = (configStore.get() as Record<string, unknown>).sync as SyncConfig | null;
          if (!cfg?.enabled) return { message: 'CloudSync not enabled. Run `/sync enable`.' };
          if (!cfg?.githubToken)
            return { message: 'No GitHub token found. Run `/sync enable owner/repo TOKEN`.' };

          let result;
          try {
            result = await cloud.push(cfg.githubToken);
          } catch (err) {
            return { message: `Push failed: ${toErrorMessage(err)}` };
          }

          if (result.ok) {
            try {
              await setSyncConfig({ ...cfg, lastSyncedAt: new Date().toISOString() });
            } catch (err) {
              return {
                message: `${result.message}\nWarning: sync completed, but metadata persistence failed: ${toErrorMessage(err)}`,
              };
            }
          }

          return { message: result.message };
        }

        case 'pull': {
          const cfg = (configStore.get() as Record<string, unknown>).sync as SyncConfig | null;
          if (!cfg?.enabled) return { message: 'CloudSync not enabled. Run `/sync enable`.' };
          if (!cfg?.githubToken)
            return { message: 'No GitHub token. Run `/sync enable owner/repo TOKEN`.' };

          let result;
          try {
            result = await cloud.pull(cfg.githubToken);
          } catch (err) {
            return { message: `Pull failed: ${toErrorMessage(err)}` };
          }

          if (result.ok) {
            try {
              await setSyncConfig({ ...cfg, lastSyncedAt: new Date().toISOString() });
            } catch (err) {
              return {
                message: `${result.message}\nWarning: sync completed, but metadata persistence failed: ${toErrorMessage(err)}`,
              };
            }
          }

          return { message: result.message };
        }

        case 'categories': {
          const [action, ...catRest] = restJoined.trim().split(/\s+/);
          const cfg = (configStore.get() as Record<string, unknown>).sync as SyncConfig | null;

          if (!cfg?.enabled) return { message: 'CloudSync not enabled. Run `/sync enable`.' };

          if (action === 'list' || !action) {
            return {
              message: [
                `Synced categories: ${cfg.categories.join(', ')}`,
                `Available: ${ALL_SYNC_CATEGORIES.join(', ')}`,
                'Update: /sync categories add <name> | remove <name>',
              ].join('\n'),
            };
          }

          if (action === 'add') {
            const catName = catRest[0] as SyncCategory;
            if (!ALL_SYNC_CATEGORIES.includes(catName)) {
              return { message: `Unknown. Available: ${ALL_SYNC_CATEGORIES.join(', ')}` };
            }
            if (cfg.categories.includes(catName))
              return { message: `"${catName}" already synced.` };
            await setSyncConfig({ ...cfg, categories: [...cfg.categories, catName] });
            return { message: `Added "${catName}" to sync categories.` };
          }

          if (action === 'remove') {
            const catName = catRest[0] as SyncCategory;
            if (!cfg.categories.includes(catName))
              return { message: `"${catName}" not in sync categories.` };
            await setSyncConfig({
              ...cfg,
              categories: cfg.categories.filter((c: SyncCategory) => c !== catName),
            });
            return { message: `Removed "${catName}" from sync categories.` };
          }

          return { message: 'Usage: /sync categories list | add <name> | remove <name>' };
        }

        default:
          return {
            message: [
              '/sync — Cloud Sync',
              '',
              '  /sync status                    Show current sync status',
              '  /sync enable owner/repo TOKEN    Enable for a repo (TOKEN = fine-grained PAT)',
              '  /sync disable                   Disable sync (keeps local data)',
              '  /sync push                      Upload selected categories',
              '  /sync pull                      Download from repo',
              '  /sync categories list|add|remove  Manage synced categories',
              '',
              `Categories: ${ALL_SYNC_CATEGORIES.join(', ')}`,
            ].join('\n'),
          };
      }
    },
  };
}
