import * as path from 'node:path';

/** `<root>/profiles/<name>/config.json` → `<root>`; any other config path → its directory. */
export function globalRootForConfigPath(configPath: string): string {
  const configDir = path.dirname(configPath);
  const profilesDir = path.dirname(configDir);
  return path.basename(profilesDir) === 'profiles' ? path.dirname(profilesDir) : configDir;
}
