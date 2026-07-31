import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packagePath = resolve(here, '..', 'package.json');

interface MinimalPackage {
  name?: string;
  version?: string;
}

let cached: { name: string; version: string } | undefined;

function readServerInfo(): { name: string; version: string } {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as MinimalPackage;
    cached = {
      name: pkg.name ?? '@wrongstack/mailbox-mcp',
      version: pkg.version ?? '0.0.0',
    };
  } catch {
    cached = { name: '@wrongstack/mailbox-mcp', version: '0.0.0' };
  }
  return cached;
}

export const SERVER_INFO = readServerInfo();
