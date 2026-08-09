import * as path from 'node:path';
import type { SlashCommand } from '@wrongstack/core/types';
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
 */
export function buildProfileCommand(opts: SlashCommandContext): SlashCommand {
  const wpaths: WstackPaths | undefined = opts.paths;
  const configStore = opts.configStore;
  const renderer = opts.renderer;

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
      'A successful /profile switch closes the current session so every service',
      'restarts against the newly selected profile.',
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
        return switchProfile(wpaths, rest, renderer);
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
): Promise<{ message: string; exit?: boolean }> {
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

  // Write the bootstrap.
  const bootstrap = { version: 1, activeProfile: safe };
  try {
    await atomicWrite(wpaths.globalConfig, JSON.stringify(bootstrap, null, 2), { mode: 0o600 });
  } catch (err) {
    const msg = `${color.red('✗')} Failed to update bootstrap config: ${err instanceof Error ? err.message : String(err)}`;
    renderer.writeWarning(msg);
    return { message: msg };
  }

  const msg =
    `${color.green('✓')} Switched to profile "${color.bold(safe)}"\n` +
    `  ${color.dim('Closing this session; restart WrongStack to activate it.')}`;
  renderer.write(msg);
  return { message: msg, exit: true };
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
