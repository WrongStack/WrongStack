import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const MAX_PASSWORD_FILE_BYTES = 4096;

export interface ResolveHqPasswordOptions {
  explicitPassword?: string | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
}

/** Resolve HQ password input without putting Docker/Kubernetes secrets in argv or env values. */
export async function resolveHqPasswordInput(
  options: ResolveHqPasswordOptions = {},
): Promise<string | undefined> {
  const environment = options.environment ?? process.env;
  const direct = options.explicitPassword ?? environment.WRONGSTACK_HQ_PASSWORD;
  const file = environment.WRONGSTACK_HQ_PASSWORD_FILE;
  if (direct !== undefined && file !== undefined) {
    throw new Error(
      'Set only one of --password/WRONGSTACK_HQ_PASSWORD or WRONGSTACK_HQ_PASSWORD_FILE.',
    );
  }
  if (file === undefined) return direct;
  if (!path.isAbsolute(file)) {
    throw new Error('WRONGSTACK_HQ_PASSWORD_FILE must be an absolute path.');
  }
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('WRONGSTACK_HQ_PASSWORD_FILE must point to a regular file.');
  if (stat.size > MAX_PASSWORD_FILE_BYTES) {
    throw new Error(`WRONGSTACK_HQ_PASSWORD_FILE exceeds ${MAX_PASSWORD_FILE_BYTES} bytes.`);
  }
  const raw = await fs.readFile(file, 'utf8');
  if (raw.includes('\0')) throw new Error('WRONGSTACK_HQ_PASSWORD_FILE contains a NUL byte.');
  // Docker secrets commonly end in exactly one editor-added newline. Preserve
  // every other byte, including intentional leading/trailing spaces.
  return raw.replace(/\r?\n$/, '');
}
