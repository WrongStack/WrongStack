/**
 * Single source of truth for the package version reported to MCP clients.
 * Kept tiny so a build step never has to run before `pnpm --filter` tests
 * can read it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(here, '..', 'package.json');

interface MinimalPackage {
  name?: string;
  version?: string;
}

let cached: { name: string; version: string } | undefined;
function readServerInfo(): { name: string; version: string } {
  if (cached) return cached;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as MinimalPackage;
    cached = {
      name: pkg.name ?? '@wrongstack/sage-mcp',
      version: pkg.version ?? '0.0.0',
    };
    return cached;
  } catch {
    cached = { name: '@wrongstack/sage-mcp', version: '0.0.0' };
    return cached;
  }
}

export const SERVER_INFO = readServerInfo();
