import * as path from 'node:path';
import type { Config, SlashCommand } from '@wrongstack/core/types';
import type { WstackPaths } from '@wrongstack/core/utils';
import { atomicWrite, color, readJsonObjectFile } from '@wrongstack/core/utils';
import type { SlashCommandContext } from './command-context.js';

/** Characters that are stripped from profile names to prevent path traversal. */
const INVALID_NAME_PATTERN = /[/\\:._]/g;

/**
 * Sanitize a profile name: strip path-traversal and filesystem-special chars.
 * Returns the sanitized name OR null when the result would be empty.
 */
function sanitizeProfileName(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(INVALID_NAME_PATTERN, '_');
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * `/profile` — manage configuration profiles.
 *
 * Each profile has its own config at ~/.wrongstack/profiles/<name>/config.json.
 * The active profile is stored in the bootstrap config (~/.wrongstack/config.json).
 *
 * Subcommands:
 *   /profile list                  Show available profiles (● = active)
 *   /profile switch <name>         Switch to an existing profile
 *   /profile copy <name>           Copy the active profile's settings to a new profile
 *
 * `switch` writes the bootstrap (the durable selection read at next boot) and
 * then pushes `activeProfile` through the live ConfigStore, which is the only
 * event source the provider-runtime rebind watcher observes. `syncConfig` is
 * the host's own copy of the merged config; it is a separate object from the
 * store, so it has to be told too or the host keeps routing against the
 * profile that was active when it booted.
 */
export function buildProfileCommand(opts: SlashCommandContext): SlashCommand {
  const wpaths: WstackPaths | undefined = opts.paths;
  const configStore = opts.configStore;
  const renderer = opts.renderer;
  const syncConfig = opts.onActiveProfileChange;

  return {
    name: 'profile',
    category: 'Config',
    description: 'Manage configuration profiles.',
    help: [
      'Usage:',
      '  /profile list               Show available profiles (● = active)',
      '  /profile switch <name>      Switch to an existing profile',
      '  /profile copy <name>        Copy the active profile to a new profile',
      '',
      'Profiles store all your settings (provider, model, fallbacks, features, etc.)',
      'in ~/.wrongstack/profiles/<name>/config.json.',
      'A successful /profile switch rebinds the live config watchers to the newly',
      'selected profile, so provider credentials and routing apply immediately.',
      'Profile-owned state resolved at boot (memory, skills, prompts, statusline)',
      'still needs a restart to follow the new profile.',
    ].join('\n'),
    async run(args) {
      if (!wpaths || !configStore) {
        const msg = 'Profile management requires config paths — unavailable in this surface.';
        renderer.writeWarning(msg);
        return { message: msg };
      }

      const trimmed = args.trim();
      const spaceIdx = trimmed.indexOf(' ');
      const sub = spaceIdx >= 0 ? trimmed.slice(0, spaceIdx).toLowerCase() : trimmed.toLowerCase();
      const rest = spaceIdx >= 0 ? trimmed.slice(spaceIdx + 1).trim() : '';

      const activeProfile = configStore.get().activeProfile ?? 'default';

      // ── bare /profile or /profile list ───────────────────────────────────
      if (!sub || sub === 'list') {
        return listProfiles(wpaths, activeProfile, renderer);
      }

      // ── switch <name> ────────────────────────────────────────────────────
      if (sub === 'switch') {
        return switchProfile(wpaths, rest, renderer, configStore, syncConfig);
      }

      // ── copy <name> ──────────────────────────────────────────────────────
      if (sub === 'copy') {
        return copyProfile(wpaths, rest, activeProfile, renderer);
      }

      const msg =
        `Unknown subcommand: "${sub}". ` +
        `Try /profile list, /profile switch <name>, or /profile copy <name>.`;
      renderer.writeWarning(msg);
      return { message: msg };
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function readdirSafe(dir: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const dirs: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(entry.name);
    }
    return dirs;
  } catch {
    return []; // profilesDir doesn't exist yet — not an error
  }
}

function formatNameError(raw: string): string {
  return (
    `${color.red('Invalid profile name:')} "${raw}" ` +
    `${color.dim('(must not contain /, \\, :, ., or "..")')}`
  );
}

// ─── list ────────────────────────────────────────────────────────────────────

async function listProfiles(
  wpaths: WstackPaths,
  activeProfile: string,
  renderer: { write: (msg: string) => void; writeWarning: (msg: string) => void },
): Promise<{ message: string }> {
  const profiles = await readdirSafe(wpaths.profilesDir);

  if (profiles.length === 0) {
    const msg = `${color.dim('No profiles found. Try /profile copy <name> to create one.')}`;
    renderer.write(msg);
    return { message: msg };
  }

  profiles.sort();
  const lines = profiles.map((name) => {
    const marker = name === activeProfile ? `${color.green('●')} ` : '  ';
    const suffix = name === activeProfile ? ` ${color.dim('(active)')}` : '';
    return `${marker}${color.bold(name)}${suffix}`;
  });

  const msg = [`${color.bold('Profiles')}`, ...lines].join('\n');
  renderer.write(msg);
  return { message: msg };
}

// ─── switch ──────────────────────────────────────────────────────────────────

async function switchProfile(
  wpaths: WstackPaths,
  nameArg: string,
  renderer: { write: (msg: string) => void; writeWarning: (msg: string) => void },
  configStore: SlashCommandContext['configStore'],
  syncConfig: ((next: Config) => void) | undefined,
): Promise<{ message: string }> {
  const safe = sanitizeProfileName(nameArg);
  if (!safe) {
    const msg = formatNameError(nameArg);
    renderer.writeWarning(msg);
    return { message: msg };
  }

  // Profile must exist.
  const profiles = await readdirSafe(wpaths.profilesDir);
  if (!profiles.includes(safe)) {
    const msg = `Profile "${safe}" does not exist. Use /profile list to see available profiles.`;
    renderer.writeWarning(msg);
    return { message: msg };
  }

  // Read profile config to verify it's valid JSON before switching.
  const profilePath = wpaths.profileConfig(safe);
  const profileData = await readJsonObjectFile(profilePath);
  if (Object.keys(profileData).length === 0) {
    const msg = `Profile "${safe}" has no settings or is corrupt — cannot switch to it.`;
    renderer.writeWarning(msg);
    return { message: msg };
  }

  // 1. Write the bootstrap: the durable selection every surface reads at boot.
  const bootstrap = { version: 1, activeProfile: safe };
  try {
    await atomicWrite(wpaths.globalConfig, JSON.stringify(bootstrap, null, 2), { mode: 0o600 });
  } catch (err) {
    const msg = `${color.red('✗')} Failed to update bootstrap config: ${err instanceof Error ? err.message : String(err)}`;
    renderer.writeWarning(msg);
    return { message: msg };
  }

  // 2. Tell the live ConfigStore. This is the ONLY thing that can reach
  // `configStore.watch`, and the provider-runtime rebind watcher
  // (wiring/provider-runtime-setup.ts) keys off `activeProfile` there to
  // close the old profile's file watchers, rebuild the config layers against
  // the new one, and re-read credentials/routing. Returning `exit: true` used
  // to make this step unreachable, which is why switching looked inert until a
  // full restart.
  // The store merges shallowly (storage/config-store.ts:60), so a bare
  // `{ activeProfile }` patch would leave every top-level key the PREVIOUS
  // profile defined live in the new one: `tools`, `features`, `context`,
  // `autonomy`, `extensions`, `mcpServers`… Carry the incoming profile's own
  // values in, and null out the outgoing profile's keys that it does not
  // redefine, so a switch drops the abandoned profile's settings instead of
  // inheriting them.
  // `version` and `activeProfile` are excluded: nulling `version` trips the
  // ConfigStore guard (config-store.ts:62) and nulling the selection defeats
  // the switch. The credential/routing whitelist is excluded because
  // `onAnyConfigChange` force-propagates those fields itself, including the
  // absent case (`mergedPatch[key] = merged[key] ?? null`); nulling them here
  // would fight that authoritative re-read.
  // Credential/routing fields are owned by the authoritative re-read the
  // rebind watcher performs: onAnyConfigChange force-propagates each of them
  // as `merged[key] ?? null` on top of whatever the store already holds, so a
  // null written here is NOT repaired — it is re-derived from the layers and
  // then merged against the null we just put in. Excluding them from the clear
  // is load-bearing, not cosmetic. Carrying them from the incoming file is
  // safe for the same reason: the watcher sets the authoritative value next.
  const WATCHER_OWNED: readonly string[] = [
    'providers',
    'apiKey',
    'baseUrl',
    'fallbackModels',
    'fallbackBridge',
    'fallbackProfiles',
    'fallbackProfile',
    'favoriteModels',
    'favoriteModelsOnly',
    'modelAvailabilitySchedule',
    'modelMatrix',
    'fallbackAuto',
    'fallbackStickiness',
    'fallbackMaxLastResortCandidates',
    'uiLocale',
  ];
  const KEEP: readonly string[] = ['version', 'activeProfile', ...WATCHER_OWNED];
  // `version` is bootstrap-only: ConfigLoader strips it out of every profile
  // file (storage/config-loader.ts:169) so a profile can never override the
  // schema version, so it must not be carried into the patch either.
  const incoming: Record<string, unknown> = { ...profileData };
  delete incoming['version'];
  const patch: Record<string, unknown> = { ...incoming, activeProfile: safe };
  const previous = configStore.get();
  const previousProfileRaw = await readJsonObjectFile(
    wpaths.profileConfig(previous.activeProfile ?? 'default'),
  );
  for (const key of Object.keys(previousProfileRaw)) {
    if (KEEP.includes(key) || key in patch) continue;
    patch[key] = null;
  }

  let next: Config;
  try {
    next = configStore.update(patch as Partial<Config>);
  } catch (err) {
    return finishSwitchFailure(renderer, safe, err);
  }

  // 3. Keep the host's own merged-config copy in sync. It is a distinct object
  // from the store's snapshot; without this the host keeps routing against the
  // profile that was active when it booted. Optional: surfaces that never wire
  // it (bare TUI, WebUI route context) fall back to bootstrap-on-next-boot.
  try {
    syncConfig?.(next);
  } catch (err) {
    return finishSwitchFailure(renderer, safe, err);
  }

  const msg =
    `${color.green('✓')} Switched to profile "${color.bold(safe)}"\n` +
    `  ${color.dim('Provider credentials and routing reloaded; boot-resolved profile state (memory, skills, prompts) applies on next start.')}`;
  renderer.write(msg);
  return { message: msg };
}

/**
 * A failed in-process rebind is NOT a failed switch: the bootstrap already
 * names the new profile, so the next boot lands there regardless. Say so, or
 * the user reads the exception as "nothing happened" and the session silently
 * keeps running against the profile they just left.
 */
function finishSwitchFailure(
  renderer: { write: (msg: string) => void; writeWarning: (msg: string) => void },
  name: string,
  err: unknown,
): { message: string } {
  const detail = err instanceof Error ? err.message : String(err);
  const msg =
    `${color.red('⚠')} Profile "${color.bold(name)}" is selected on disk, ` +
    `but it could not be applied to this session: ${detail}\n` +
    `  ${color.dim('Restart WrongStack to finish the switch.')}`;
  renderer.writeWarning(msg);
  return { message: msg };
}

// ─── copy ────────────────────────────────────────────────────────────────────

async function copyProfile(
  wpaths: WstackPaths,
  nameArg: string,
  activeProfile: string,
  renderer: { write: (msg: string) => void; writeWarning: (msg: string) => void },
): Promise<{ message: string }> {
  // Validate and sanitize the new profile name.
  const safe = sanitizeProfileName(nameArg);
  if (!safe) {
    const msg = formatNameError(nameArg);
    renderer.writeWarning(msg);
    return { message: msg };
  }

  // Source must exist and have content.
  const srcPath = wpaths.profileConfig(activeProfile);
  const srcConfig = await readJsonObjectFile(srcPath);
  if (Object.keys(srcConfig).length === 0) {
    const msg = `Profile "${activeProfile}" has no settings to copy.`;
    renderer.writeWarning(msg);
    return { message: msg };
  }

  // Destination profile directory must not already exist. Profiles own more
  // than config.json (memory, skills, prompts, modes, history, sync state), so
  // copying only the config would create a partial profile.
  const destPath = wpaths.profileConfig(safe);
  const srcDir = path.dirname(srcPath);
  const destDir = path.dirname(destPath);
  const { access, cp } = await import('node:fs/promises');
  try {
    await access(destDir);
    const msg = `Profile "${safe}" already exists. Use a different name.`;
    renderer.writeWarning(msg);
    return { message: msg };
  } catch {
    // Missing destination is expected.
  }

  // Clone the complete profile tree.
  try {
    await cp(srcDir, destDir, { recursive: true, errorOnExist: true, force: false });
  } catch (err) {
    const msg = `${color.red('✗')} Failed to copy profile: ${err instanceof Error ? err.message : String(err)}`;
    renderer.writeWarning(msg);
    return { message: msg };
  }

  const msg =
    `${color.green('✓')} Copied profile "${color.bold(activeProfile)}" → "${color.bold(safe)}"\n` +
    `  ${color.dim(`Use /profile switch ${safe} to activate it.`)}`;
  renderer.write(msg);
  return { message: msg };
}
