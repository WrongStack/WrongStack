import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

function userBinDirs(env: NodeJS.ProcessEnv, windows: boolean): string[] {
  const candidates: string[] = [];
  if (windows) {
    if (env.APPDATA) candidates.push(join(env.APPDATA, 'npm'));
    if (env.LOCALAPPDATA) candidates.push(join(env.LOCALAPPDATA, 'pnpm'));
    const home = env.USERPROFILE ?? env.HOME;
    if (home) {
      candidates.push(join(home, '.bun', 'bin'));
      candidates.push(join(home, '.local', 'bin'));
      candidates.push(join(home, '.cargo', 'bin'));
    }
  } else if (env.HOME) {
    candidates.push(
      join(env.HOME, '.local', 'bin'),
      join(env.HOME, '.bun', 'bin'),
      join(env.HOME, '.cargo', 'bin'),
      join(env.HOME, '.npm-global', 'bin'),
    );
  }
  return candidates.filter(isAbsolute);
}

/** Check for an executable without launching it. */
export function acpCommandOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const windows = platform === 'win32';
  const extensions = windows ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
  const searchDirs = [
    ...new Set([
      ...(env.PATH ?? env.Path ?? '')
        .split(windows ? ';' : ':')
        .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
        .filter(isAbsolute),
      ...userBinDirs(env, windows),
    ]),
  ];
  const paths = isAbsolute(command)
    ? [command]
    : /[/\\]/.test(command)
      ? []
      : searchDirs.map((dir) => join(dir, command));
  return paths.some((base) =>
    extensions.some((ext) => {
      const file = base + ext;
      try {
        accessSync(file, windows ? constants.F_OK : constants.X_OK);
        return statSync(file).isFile();
      } catch {
        return false;
      }
    }),
  );
}
