import { readFileSync } from 'node:fs';

export function readBunLock(file) {
  return Bun.JSONC.parse(readFileSync(file, 'utf8'));
}
