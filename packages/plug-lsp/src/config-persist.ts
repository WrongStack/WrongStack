import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { PLUGIN_NAME } from './config.js';
import type { ServerConfig } from './types.js';

/**
 * Where `/lsp` writes server entries: the project-private config
 * (`~/.wrongstack/projects/<slug>/config.local.json`), NOT the repo-committed
 * `.wrongstack/config.json`. The in-project layer denies `extensions`
 * outright — a repo must not be able to point a language server at an
 * arbitrary binary — so anything written there would be stripped on load and
 * the command would silently do nothing.
 */
export function serverConfigPath(cwd: string): string {
  return resolveWstackPaths({ projectRoot: cwd }).projectLocalConfig;
}

type ServerPatch = { readonly [K in keyof ServerConfig]?: ServerConfig[K] };

/**
 * Read-modify-write one server entry under
 * `extensions["@wrongstack/plug-lsp"].servers`. Passing `null` removes it.
 * Every other key in the file is preserved verbatim — this file also carries
 * the project's credentials.
 */
export async function persistServerConfig(
  cwd: string,
  name: string,
  patch: ServerPatch | null,
): Promise<string> {
  const target = serverConfigPath(cwd);
  const config = await readConfigFile(target);

  const extensions = asRecord(config.extensions) ?? {};
  const section = asRecord(extensions[PLUGIN_NAME]) ?? {};
  const servers = asRecord(section.servers) ?? {};

  if (patch === null) {
    delete servers[name];
  } else {
    servers[name] = { ...(asRecord(servers[name]) ?? {}), ...patch };
  }

  section.servers = servers;
  extensions[PLUGIN_NAME] = section;
  config.extensions = extensions;
  if (typeof config.version !== 'number') config.version = 1;

  await fs.mkdir(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(
    tmp,
    `${JSON.stringify(config, null, 2)}
`,
    { encoding: 'utf8', mode: 0o600 },
  );
  await fs.rename(tmp, target);
  return target;
}

async function readConfigFile(target: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 };
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  // A corrupt file must fail loudly: silently starting from {} would drop the
  // credentials this file also holds.
  const record = asRecord(parsed);
  if (!record) throw new Error(`Config at ${target} is not a JSON object`);
  return record;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
