import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

/** Check for an executable without launching it. */
export function acpCommandOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const windows = platform === 'win32';
  const extensions = windows ? ['', ...(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
  const paths = isAbsolute(command)
    ? [command]
    : /[/\\]/.test(command)
      ? []
      : (env.PATH ?? env.Path ?? '')
          .split(windows ? ';' : ':')
          .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
          .filter(isAbsolute)
          .map((dir) => join(dir, command));
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
