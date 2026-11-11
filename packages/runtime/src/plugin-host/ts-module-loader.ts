import { createHash } from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { definePlugin, KERNEL_API_VERSION } from '@wrongstack/core/plugin';

export interface ImportPluginModuleOptions {
  /** Monotonic generation counter (> 0 triggers ESM cache eviction & fresh closure load). */
  reloadGeneration?: number | undefined;
  /** Optional directory root owned solely by this plugin (for deep helper cache eviction). */
  pluginDirectory?: string | undefined;
}

const HOST_SCOPED_PACKAGE_RE = /^@wrongstack\/(plugin-sdk|contracts|core)(\/|$)/;
const VIRTUAL_SDK_NAMESPACE = 'wstack-virtual';
const VIRTUAL_SDK_SOURCE =
  'const bridge = globalThis.__wstackPluginSdkBridge;\n' +
  'export const definePlugin = bridge.definePlugin;\n' +
  'export const KERNEL_API_VERSION = bridge.KERNEL_API_VERSION;\n';

interface PluginSdkGlobalBridge {
  __wstackPluginSdkBridge?: {
    definePlugin: typeof definePlugin;
    KERNEL_API_VERSION: typeof KERNEL_API_VERSION;
  };
  __wstackStandaloneSdkPluginRegistered?: boolean;
}

function installGlobalSdkBridge(): void {
  const g = globalThis as unknown as PluginSdkGlobalBridge;
  if (!g.__wstackPluginSdkBridge) {
    g.__wstackPluginSdkBridge = { definePlugin, KERNEL_API_VERSION };
  }
}

/**
 * Resolve `@wrongstack/plugin-sdk`, `@wrongstack/contracts/*`, or `@wrongstack/core/*`
 * against the running host installation so standalone `.ts`/`.mts` files in
 * `~/.wrongstack/plugins/` or `os.tmpdir()` work without a local `node_modules`.
 */
export function resolveHostPackageSpecifier(specifier: string): string | undefined {
  if (!HOST_SCOPED_PACKAGE_RE.test(specifier)) return undefined;
  try {
    const req = createRequire(import.meta.url);
    return req.resolve(specifier);
  } catch {
    return undefined;
  }
}

interface BunPluginBuilder {
  onResolve(
    filter: { filter: RegExp },
    cb: (args: {
      path: string;
      importer?: string;
      resolveDir?: string;
    }) => { path: string; external?: boolean; namespace?: string } | undefined,
  ): void;
  onLoad?(
    filter: { filter: RegExp; namespace?: string },
    cb: () => { contents: string; loader: 'js' | 'ts' },
  ): void;
}

interface BunGlobalLike {
  plugin?: (pluginDef: { name: string; setup(build: BunPluginBuilder): void }) => void;
  build?: (config: {
    entrypoints: string[];
    target: 'bun';
    format: 'esm';
    plugins?: Array<{
      name: string;
      setup(build: BunPluginBuilder): void;
    }>;
  }) => Promise<{
    success: boolean;
    logs: Array<{ message?: string }>;
    outputs: Array<{ text(): Promise<string> }>;
  }>;
  resolveSync?: (specifier: string, parent: string) => string;
}

/**
 * Register a once-per-process runtime loader hook under Bun so external single-file
 * plugins located outside any `node_modules` hierarchy can `import { definePlugin }
 * from '@wrongstack/plugin-sdk'` on both initial load and hot reload.
 */
export function ensureStandalonePluginSdkResolver(): void {
  installGlobalSdkBridge();
  const g = globalThis as unknown as PluginSdkGlobalBridge;
  if (g.__wstackStandaloneSdkPluginRegistered) return;
  const bunGlobal = (globalThis as { Bun?: BunGlobalLike }).Bun;
  if (typeof bunGlobal?.plugin !== 'function') return;

  g.__wstackStandaloneSdkPluginRegistered = true;
  bunGlobal.plugin({
    name: 'wstack-standalone-sdk-resolver',
    setup(build) {
      build.onResolve({ filter: HOST_SCOPED_PACKAGE_RE }, (args) => {
        if (args.path === '@wrongstack/plugin-sdk') {
          return { path: 'plugin-sdk', namespace: VIRTUAL_SDK_NAMESPACE };
        }
        const resolved = resolveHostPackageSpecifier(args.path);
        if (resolved) {
          return { path: resolved };
        }
        return undefined;
      });
      build.onLoad?.({ filter: /^plugin-sdk$/, namespace: VIRTUAL_SDK_NAMESPACE }, () => ({
        contents: VIRTUAL_SDK_SOURCE,
        loader: 'js',
      }));
    },
  });
}

/**
 * Evict cached modules belonging to an external plugin from the runtime's
 * `require.cache` (unified CJS + ESM module registry in Bun), preventing stale
 * relative `.ts`/`.js` helper modules and unbounded cache growth across reloads.
 */
export function evictRuntimeModuleCache(
  entryUrl: string,
  pluginDirectory?: string | undefined,
): number {
  let cache: NodeJS.Dict<NodeModule> | undefined;
  try {
    cache = createRequire(import.meta.url).cache;
  } catch {
    return 0;
  }
  if (!cache) return 0;

  const cleanBaseUrl = entryUrl.split('?')[0] ?? entryUrl;
  const cleanFsPath = cleanBaseUrl.startsWith('file:')
    ? fileURLToPath(cleanBaseUrl).replaceAll('\\', '/')
    : cleanBaseUrl.replaceAll('\\', '/');
  const normalizedDir = pluginDirectory?.replaceAll('\\', '/').replace(/\/+$/, '');

  let evicted = 0;
  for (const key of Object.keys(cache)) {
    const keyClean = (key.split('?')[0] ?? key).replaceAll('\\', '/');
    const matchesEntry = keyClean === cleanFsPath || keyClean === cleanBaseUrl;
    const matchesDir =
      normalizedDir !== undefined &&
      (keyClean.startsWith(`${normalizedDir}/`) ||
        keyClean.startsWith(pathToFileURL(`${normalizedDir}/`).href));
    if (matchesEntry || matchesDir) {
      delete cache[key];
      evicted += 1;
    }
  }
  return evicted;
}

async function importTypeScriptViaNodeFallback(entryPath: string, gen: number): Promise<unknown> {
  installGlobalSdkBridge();
  const nodeModule = (await import('node:module')) as {
    stripTypeScriptTypes?: (code: string, options?: { mode?: 'strip' | 'transform' }) => string;
  };
  if (typeof nodeModule.stripTypeScriptTypes !== 'function') {
    const sep = pathToFileURL(entryPath).href.includes('?') ? '&' : '?';
    return import(`${pathToFileURL(entryPath).href}${gen > 0 ? `${sep}wstack_reload=${gen}` : ''}`);
  }
  const rawTs = await readFile(entryPath, 'utf8');
  let stripped = nodeModule.stripTypeScriptTypes(rawTs, { mode: 'strip' });
  const entryDir = dirname(entryPath);

  // Rewrite relative specifiers and `@wrongstack/*` specifiers so `data:text/javascript` works cleanly.
  stripped = stripped.replace(
    /(\bfrom\s+['"]|\bimport\s*\(\s*['"])([^'"]+)(['"])/g,
    (_full, prefix: string, spec: string, suffix: string) => {
      if (spec.startsWith('./') || spec.startsWith('../')) {
        return `${prefix}${pathToFileURL(resolve(entryDir, spec)).href}${suffix}`;
      }
      const hostPkg = resolveHostPackageSpecifier(spec);
      if (hostPkg) {
        return `${prefix}${pathToFileURL(hostPkg).href}${suffix}`;
      }
      if (spec === '@wrongstack/plugin-sdk') {
        const inlineData = `data:text/javascript;base64,${Buffer.from(VIRTUAL_SDK_SOURCE, 'utf8').toString('base64')}`;
        return `${prefix}${inlineData}${suffix}`;
      }
      return `${prefix}${spec}${suffix}`;
    },
  );

  const encoded = Buffer.from(stripped, 'utf8').toString('base64');
  return import(`data:text/javascript;base64,${encoded}#g=${gen}`);
}

async function bundleAndImportViaBun(
  bunGlobal: BunGlobalLike,
  entryPath: string,
  gen: number,
): Promise<unknown> {
  if (typeof bunGlobal.build !== 'function') {
    const sep = pathToFileURL(entryPath).href.includes('?') ? '&' : '?';
    return import(`${pathToFileURL(entryPath).href}${gen > 0 ? `${sep}wstack_reload=${gen}` : ''}`);
  }
  const normalizedEntry = entryPath.replaceAll('\\', '/');
  const result = await bunGlobal.build({
    entrypoints: [entryPath],
    target: 'bun',
    format: 'esm',
    plugins: [
      {
        name: 'wstack-externalize-packages',
        setup(build) {
          // Bundle relative imports (`./helper.ts`, `../shared.ts`) freshly from disk,
          // while keeping built-ins (`node:*`, `bun:*`) and bare packages external.
          build.onResolve({ filter: /.*/ }, (args) => {
            const spec = args.path;
            if (spec.startsWith('./') || spec.startsWith('../')) {
              return undefined;
            }
            if (
              spec.replaceAll('\\', '/') === normalizedEntry ||
              /^[A-Za-z]:[\\/]/.test(spec) ||
              spec.startsWith('/')
            ) {
              return undefined;
            }
            if (spec.startsWith('node:') || spec.startsWith('bun:') || spec.startsWith('file:')) {
              return { path: spec, external: true };
            }
            if (spec === '@wrongstack/plugin-sdk') {
              return { path: 'plugin-sdk', namespace: VIRTUAL_SDK_NAMESPACE };
            }
            if (typeof bunGlobal.resolveSync === 'function') {
              try {
                const resolved = bunGlobal.resolveSync(spec, args.resolveDir || dirname(entryPath));
                return { path: pathToFileURL(resolved).href, external: true };
              } catch {
                // Fall through to host package resolver for standalone external plugins.
              }
            }
            const hostResolved = resolveHostPackageSpecifier(spec);
            if (hostResolved) {
              return { path: pathToFileURL(hostResolved).href, external: true };
            }
            return { path: spec, external: true };
          });
          build.onLoad?.({ filter: /^plugin-sdk$/, namespace: VIRTUAL_SDK_NAMESPACE }, () => ({
            contents: VIRTUAL_SDK_SOURCE,
            loader: 'js',
          }));
        },
      },
    ],
  });
  if (!result.success || result.outputs.length === 0) {
    const reason =
      result.logs.map((l) => l.message ?? String(l)).join('; ') ||
      'Failed to transpile plugin module';
    throw new SyntaxError(reason);
  }
  const code = await result.outputs[0]!.text();
  const cacheDir = join(tmpdir(), 'wrongstack-plugin-reload');
  await mkdir(cacheDir, { recursive: true });
  const digest = createHash('sha256').update(normalizedEntry).digest('hex').slice(0, 12);
  const transientPath = join(cacheDir, `plugin-${digest}-g${gen}-${process.pid}-${Date.now()}.mjs`);
  await writeFile(transientPath, code, { encoding: 'utf8', mode: 0o600 });
  try {
    return await import(pathToFileURL(transientPath).href);
  } finally {
    await unlink(transientPath).catch(() => undefined);
  }
}

/**
 * Dynamically import an external `.ts`, `.mts`, `.js`, `.mjs`, `.cjs`, or npm
 * specifier plugin module, with full relative-closure cache invalidation on hot reload.
 */
export async function importExternalPluginModule(
  importTarget: string,
  opts: ImportPluginModuleOptions = {},
): Promise<unknown> {
  ensureStandalonePluginSdkResolver();
  const gen = opts.reloadGeneration ?? 0;
  const bunGlobal = (globalThis as { Bun?: BunGlobalLike }).Bun;

  if (importTarget.startsWith('file:')) {
    const cleanUrl = importTarget.split('?')[0] ?? importTarget;
    const entryPath = fileURLToPath(cleanUrl);
    const isTsEntry = /\.(?:ts|mts)$/i.test(entryPath);

    if (!bunGlobal && isTsEntry) {
      if (gen > 0) evictRuntimeModuleCache(importTarget, opts.pluginDirectory);
      return importTypeScriptViaNodeFallback(entryPath, gen);
    }

    if (gen > 0) {
      evictRuntimeModuleCache(importTarget, opts.pluginDirectory);
      if (bunGlobal && typeof bunGlobal.build === 'function') {
        return bundleAndImportViaBun(bunGlobal, entryPath, gen);
      }
      const sep = importTarget.includes('?') ? '&' : '?';
      return import(`${importTarget}${sep}wstack_reload=${gen}`);
    }

    try {
      return await import(importTarget);
    } catch (err) {
      // Standalone external plugins outside any `node_modules` tree (e.g. ~/.wrongstack/plugins/*.ts)
      // may fail direct ESM bare-specifier resolution under embedded module runners; bundle with
      // the host SDK virtual bridge before surfacing an import failure.
      if (bunGlobal && typeof bunGlobal.build === 'function') {
        return bundleAndImportViaBun(bunGlobal, entryPath, 0);
      }
      if (!bunGlobal && isTsEntry) {
        return importTypeScriptViaNodeFallback(entryPath, 0);
      }
      throw err;
    }
  }

  return import(importTarget);
}
