import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveWstackPaths } from '@wrongstack/core/utils';

export function resolveWebUiEntry(): string {
  if (process.env['WRONGSTACK_WEBUI_ENTRY']) {
    return path.resolve(process.env['WRONGSTACK_WEBUI_ENTRY']);
  }
  const require = createRequire(import.meta.url);
  try {
    const serverPkgPath = require.resolve('@wrongstack/webui-server/package.json');
    const candidate = path.join(path.dirname(serverPkgPath), 'dist', 'server', 'entry.js');
    if (existsSync(candidate)) return candidate;
  } catch {
    // fall through to legacy path
  }
  const serverIndex = require.resolve('@wrongstack/webui-server');
  return path.join(path.dirname(serverIndex), 'server', 'entry.js');
}

export function resolveWebUiDistDir(): string {
  if (process.env['WRONGSTACK_WEBUI_DIST']) {
    return path.resolve(process.env['WRONGSTACK_WEBUI_DIST']);
  }
  const require = createRequire(import.meta.url);
  const serverEntry = require.resolve('@wrongstack/webui');
  const candidate = path.dirname(serverEntry);
  if (existsSync(candidate)) return candidate;
  throw new Error(
    `WebUI frontend assets not found at ${candidate}. Build @wrongstack/webui or set WRONGSTACK_WEBUI_DIST.`,
  );
}

export function rendererIndexPath(): string {
  return new URL('../renderer/index.html', import.meta.url).href;
}

export function preloadPath(): string {
  return fileURLToPath(new URL('../preload/preload.cjs', import.meta.url));
}

export function webuiPreloadPath(): string {
  return fileURLToPath(new URL('../preload/webui-preload.cjs', import.meta.url));
}

export function desktopSettingsWorkspaceRoot(): string {
  return path.join(resolveWstackPaths({ projectRoot: process.cwd() }).configDir, 'settings');
}
