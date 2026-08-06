import type { Config } from '@wrongstack/core/types';
import type { WstackPaths } from '@wrongstack/core/utils';

/**
 * Resolve the selected profile without ever treating the root bootstrap as
 * settings.
 *
 * Module-private: the only caller is `activeProfileConfigPath` below, and
 * exporting it invited the third hand-rolled copy that used to live in
 * `boot/tui-settings-adapter.ts`. Core exports a same-shaped
 * `bootstrapProfileName` that answers from the DISK bootstrap instead of the
 * live config — two exported functions with near-identical names is how a
 * caller autocompletes the wrong source.
 */
function activeProfileName(config: Pick<Config, 'activeProfile'>): string {
  return typeof config.activeProfile === 'string' && config.activeProfile.trim()
    ? config.activeProfile
    : 'default';
}

/** Canonical settings file for the currently selected profile. */
export function activeProfileConfigPath(
  paths: Pick<WstackPaths, 'profileConfig'>,
  config: Pick<Config, 'activeProfile'>,
): string {
  return paths.profileConfig(activeProfileName(config));
}
