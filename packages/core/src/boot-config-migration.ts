import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { restrictDirPermissions, restrictFilePermissions } from './security/file-permissions.js';
import { atomicWrite } from './utils/atomic-write.js';
import { safeParse } from './utils/safe-json.js';
import { writeErr } from './utils/term.js';
import { safeProfileName, type WstackPaths } from './utils/wstack-paths.js';

/**
 * Before 0.291.0, all config lived in ~/.wrongstack/config.json.
 * Starting with 0.291.0, the root config is a thin bootstrap (version +
 * activeProfile) and settings live in ~/.wrongstack/profiles/<name>/config.json.
 *
 * This function migrates a legacy flat config into the default profile config
 * BEFORE any config loader runs, so the loader always reads from the right place.
 *
 * Migration is allowed only when the selected profile file does not exist.
 * An existing empty or corrupt profile is still authoritative: root settings
 * must never be re-imported once profiles are in use.
 */
export async function migrateLegacyConfig(wpaths: WstackPaths): Promise<void> {
  const rootFp = wpaths.globalConfig;

  // If legacy root doesn't exist, nothing to migrate.
  let legacyRaw: string;
  try {
    legacyRaw = await fs.readFile(rootFp, 'utf8');
  } catch {
    return; // ENOENT or other error — nothing to migrate
  }

  // Validate the legacy content is parseable JSON with actual settings.
  const result = safeParse<Record<string, unknown>>(legacyRaw);
  if (
    !result.ok ||
    !result.value ||
    typeof result.value !== 'object' ||
    Array.isArray(result.value)
  ) {
    return;
  }

  const activeProfile = safeProfileName(
    typeof result.value['activeProfile'] === 'string' ? result.value['activeProfile'] : undefined,
  );
  const profileFp = wpaths.profileConfig(activeProfile);

  // File existence, not content, is the boundary. Never recover settings from
  // root over an existing profile, even when that profile is empty or corrupt.
  try {
    await fs.access(profileFp);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
  }

  await fs.mkdir(path.dirname(profileFp), { recursive: true });

  // Copy legacy content into the profile config, stripping bootstrap-only fields.
  const profileContent = { ...result.value };
  delete profileContent['activeProfile'];

  await atomicWrite(profileFp, JSON.stringify(profileContent, null, 2), { mode: 0o600 });

  // Write the root config as a thin bootstrap pointer.
  const bootstrap = { version: 1, activeProfile };

  try {
    await atomicWrite(rootFp, JSON.stringify(bootstrap, null, 2), { mode: 0o600 });
  } catch {
    // best-effort — profile already migrated
  }
}

/** Pairs of (legacy root source, profile destination) that need migration. */
export const PROFILE_STATE_PAIRS: ReadonlyArray<{
  globalSrc: (wpaths: WstackPaths) => string;
  profileDst: (wpaths: WstackPaths, name: string) => string;
}> = [
  {
    globalSrc: (w) => path.join(w.globalRoot, 'statusline.json'),
    profileDst: (w, n) => w.profileStatuslineConfig(n),
  },
  {
    globalSrc: (w) => path.join(w.globalRoot, 'mode.json'),
    profileDst: (w, n) => w.profileModeConfig(n),
  },
  {
    globalSrc: (w) => path.join(w.globalRoot, 'provider-status.json'),
    profileDst: (w, n) => w.profileProviderStatus(n),
  },
  {
    globalSrc: (w) => path.join(w.globalRoot, 'update-cache.json'),
    profileDst: (w, n) => w.profileUpdateCache(n),
  },
  {
    globalSrc: (w) => path.join(w.globalRoot, 'memory.md'),
    profileDst: (w, n) => path.join(w.profilesDir, n, 'memory.md'),
  },
  {
    globalSrc: (w) => path.join(w.globalRoot, 'history'),
    profileDst: (w, n) => path.join(w.profilesDir, n, 'history'),
  },
  {
    globalSrc: (w) => path.join(w.globalRoot, 'sync.json'),
    profileDst: (w, n) => path.join(w.profilesDir, n, 'sync.json'),
  },
  {
    globalSrc: (w) => path.join(w.globalRoot, 'sync-state.json'),
    profileDst: (w, n) => path.join(w.profilesDir, n, 'sync-state.json'),
  },
  {
    globalSrc: (w) => path.join(w.globalRoot, 'prompt-usage.json'),
    profileDst: (w, n) => path.join(w.profilesDir, n, 'prompt-usage.json'),
  },
  {
    globalSrc: (w) => path.join(w.globalRoot, 'custom-context-modes.json'),
    profileDst: (w, n) => path.join(w.profilesDir, n, 'custom-context-modes.json'),
  },
  {
    globalSrc: (w) => path.join(w.globalRoot, 'installed-skills.json'),
    profileDst: (w, n) => path.join(w.profilesDir, n, 'installed-skills.json'),
  },
  ...['skills', 'prompts', 'instructions', 'design-kits', 'settings'].map((directory) => ({
    globalSrc: (w: WstackPaths) => path.join(w.globalRoot, directory),
    profileDst: (w: WstackPaths, n: string) => path.join(w.profilesDir, n, directory),
  })),
];

/**
 * F56 (WS-045 copy-time class): on Windows fs.cp gives copied children the
 * destination's inherited ACL, not the source's owner-only ACL. Harden the
 * whole copied tree (best-effort — the caller's catch never blocks boot).
 */
async function hardenCopiedTree(root: string): Promise<void> {
  await restrictDirPermissions(root, { label: 'profile-migration' });
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) await hardenCopiedTree(full);
    else if (entry.isFile()) await restrictFilePermissions(full, { label: 'profile-migration' });
  }
}

/**
 * Migrate legacy profile-owned files and directories from the global root
 * into the active profile's directory. Runs after migrateLegacyConfig() so the
 * active profile name is resolved from the now-migrated root bootstrap.
 *
 * For each entry: if it exists in the profile directory, it's left untouched
 * (idempotent). If it's missing in the profile but exists at the global root,
 * it's copied into the profile. If neither exists, silently skipped.
 * Best-effort: failures never block boot.
 */
export async function migrateProfileFiles(wpaths: WstackPaths): Promise<void> {
  // Read the active profile name from the bootstrap (already migrated by
  // migrateLegacyConfig above). Default to 'default' if unset.
  let profileName = wpaths.profileName;
  try {
    const raw = await fs.readFile(wpaths.globalConfig, 'utf8');
    const parsed = safeParse<Record<string, unknown>>(raw);
    if (parsed.ok && parsed.value && typeof parsed.value.activeProfile === 'string') {
      profileName = safeProfileName(parsed.value.activeProfile);
    }
  } catch {
    // best-effort — default profile
  }

  // Ensure the profile directory exists so the copy targets are writable.
  try {
    await fs.mkdir(path.join(wpaths.profilesDir, profileName), { recursive: true });
  } catch {
    return;
  }

  for (const pair of PROFILE_STATE_PAIRS) {
    const src = pair.globalSrc(wpaths);
    const dst = pair.profileDst(wpaths, profileName);

    // Confirm the global source exists and capture its type.
    let srcIsDir: boolean;
    try {
      srcIsDir = (await fs.stat(src)).isDirectory();
    } catch {
      continue; // no global source — nothing to migrate
    }

    // Skip if the profile already has this entry with the matching type
    // (idempotent). A type mismatch indicates corrupt partial state left by
    // a botched earlier migration (e.g. a file where a directory belongs);
    // remove the wrong-typed stub so the copy below can recover the tree.
    try {
      const dstStat = await fs.stat(dst);
      if (dstStat.isDirectory() === srcIsDir) {
        continue; // already migrated with the correct type
      }
      await fs.rm(dst, { recursive: true, force: true });
    } catch (err) {
      // Only proceed to copy when dst genuinely doesn't exist (ENOENT).
      // Other errors (EACCES, EMFILE, …) mean we can't safely determine
      // dst state — skip this entry rather than risk a broken copy.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        writeErr(`migrateProfileFiles: skipping ${dst} (stat error: ${code ?? 'unknown'})\n`);
        continue;
      }
    }

    // Copy the global file/directory into the profile directory.
    try {
      if (srcIsDir) {
        await fs.cp(src, dst, { recursive: true, errorOnExist: false, force: false });
        await hardenCopiedTree(dst);
      } else {
        const content = await fs.readFile(src);
        await fs.writeFile(dst, content, { mode: 0o600 });
        // F41 (WS-045 class): on Windows `mode: 0o600` is a no-op, so copied
        // profile state (memory.md, sync.json, …) stayed readable by other
        // local accounts where inheritance was not owner-only. Harden the copy
        // (best-effort — the surrounding catch never blocks boot).
        await restrictFilePermissions(dst, { label: 'profile-migration' });
      }
    } catch {
      // best-effort — never block boot
    }
  }
}
