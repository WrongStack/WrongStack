import { createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { definePlugin, KERNEL_API_VERSION } from '@wrongstack/core/plugin';

/** Maximum local relative files allowed in a single external plugin closure. */
const MAX_PLUGIN_CLOSURE_FILES = 64;

export interface ImportPluginModuleOptions {
  /** Monotonic generation counter (> 0 triggers ESM cache eviction & fresh closure load). */
  reloadGeneration?: number | undefined;
  /** Optional directory root owned solely by this plugin (for deep helper cache eviction). */
  pluginDirectory?: string | undefined;
  /** Optional Node.js `stripTypeScriptTypes` override (forces the Node closure fallback path). */
  stripTypeScriptTypes?:
    | ((code: string, options?: { mode?: 'strip' | 'transform' }) => string)
    | undefined;
}

interface NodeTypeStripFallbackOptions {
  /** Optional custom TypeScript stripper/transformer (defaults to `node:module.stripTypeScriptTypes`). */
  stripTypeScriptTypes?:
    | ((code: string, options?: { mode?: 'strip' | 'transform' }) => string)
    | undefined;
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

function resolveLocalRelativeFile(fromDir: string, specifier: string): string | undefined {
  const cleanSpec = specifier.split(/[?#]/)[0] ?? specifier;
  const base = resolve(fromDir, cleanSpec);
  const candidates: string[] = [];

  if (cleanSpec.endsWith('.js')) {
    const stem = base.slice(0, -3);
    candidates.push(`${stem}.ts`, `${stem}.mts`, base);
  } else if (cleanSpec.endsWith('.mjs')) {
    const stem = base.slice(0, -4);
    candidates.push(`${stem}.mts`, base);
  } else if (cleanSpec.endsWith('.cjs')) {
    const stem = base.slice(0, -4);
    candidates.push(`${stem}.cts`, base);
  } else if (/\.[a-z0-9]+$/i.test(cleanSpec)) {
    candidates.push(base);
  } else {
    candidates.push(
      `${base}.ts`,
      `${base}.mts`,
      `${base}.js`,
      `${base}.mjs`,
      join(base, 'index.ts'),
      join(base, 'index.mts'),
      join(base, 'index.js'),
      join(base, 'index.mjs'),
    );
  }

  for (const candidate of candidates) {
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
      return candidate;
    }
  }
  return undefined;
}

function transpileTypeScriptSource(
  rawSource: string,
  sourcePath: string,
  stripFn: (code: string, options?: { mode?: 'strip' | 'transform' }) => string,
): string {
  if (!/\.(?:ts|mts|cts)$/i.test(sourcePath)) {
    return rawSource;
  }
  try {
    return stripFn(rawSource, { mode: 'strip' });
  } catch {
    // Non-erasable TypeScript syntax (`enum`, `namespace`, parameter properties) throws
    // `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` under `mode: 'strip'`; fall back to `mode: 'transform'`.
    return stripFn(rawSource, { mode: 'transform' });
  }
}

/**
 * Node.js 22.7+ / 24 LTS / 26 fallback loader for zero-build `.ts`/`.mts` plugins.
 * Walks the bounded local relative import graph (`<= 64` files), strips/transforms
 * TypeScript types, preserves `.ts` stack trace locations via inline `//# sourceURL=`,
 * and emits a per-reload transient `.mjs` closure so helper edits reload cleanly.
 */
async function importTypeScriptViaNodeFallback(
  entryPath: string,
  gen: number,
  options: NodeTypeStripFallbackOptions = {},
): Promise<unknown> {
  installGlobalSdkBridge();
  const nodeModule = (await import('node:module')) as {
    stripTypeScriptTypes?: (code: string, options?: { mode?: 'strip' | 'transform' }) => string;
  };
  const stripFn = options.stripTypeScriptTypes ?? nodeModule.stripTypeScriptTypes;
  if (typeof stripFn !== 'function') {
    const sep = pathToFileURL(entryPath).href.includes('?') ? '&' : '?';
    return import(`${pathToFileURL(entryPath).href}${gen > 0 ? `${sep}wstack_reload=${gen}` : ''}`);
  }

  const normalizedEntry = resolve(entryPath);
  const digest = createHash('sha256')
    .update(normalizedEntry.replaceAll('\\', '/'))
    .digest('hex')
    .slice(0, 12);
  const nonce = Math.random().toString(36).slice(2, 8);
  const tempDir = join(
    tmpdir(),
    'wrongstack-plugin-cache',
    `closure-${digest}-g${gen}-${process.pid}-${Date.now()}-${nonce}`,
  );
  await mkdir(tempDir, { recursive: true, mode: 0o700 });

  const sdkPath = join(tempDir, 'sdk-bridge.mjs');
  await writeFile(sdkPath, VIRTUAL_SDK_SOURCE, { encoding: 'utf8', mode: 0o600 });

  const visited = new Map<string, string>();
  const pendingWrites: Promise<void>[] = [];

  const emitLocalModule = async (sourcePath: string): Promise<string> => {
    const canonical = resolve(sourcePath);
    const existing = visited.get(canonical);
    if (existing) return existing;

    if (visited.size >= MAX_PLUGIN_CLOSURE_FILES) {
      throw new Error(
        `Plugin relative import closure exceeds maximum of ${MAX_PLUGIN_CLOSURE_FILES} local files (${entryPath})`,
      );
    }

    const outName = `./mod-${visited.size}.mjs`;
    visited.set(canonical, outName);

    const rawCode = await readFile(canonical, 'utf8');
    const stripped = transpileTypeScriptSource(rawCode, canonical, stripFn);
    const fromDir = dirname(canonical);

    const specifierPattern = /(\b(?:from|import)\s+['"]|\bimport\s*\(\s*['"])([^'"]+)(['"])/g;
    const discoveredSpecs = new Set<string>();
    for (const match of stripped.matchAll(specifierPattern)) {
      if (match[2]) discoveredSpecs.add(match[2]);
    }

    const rewriteTable = new Map<string, string>();
    for (const spec of discoveredSpecs) {
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const localTarget = resolveLocalRelativeFile(fromDir, spec);
        if (localTarget) {
          const childOut = await emitLocalModule(localTarget);
          rewriteTable.set(spec, childOut);
        } else {
          const fallbackUrl = pathToFileURL(resolve(fromDir, spec)).href;
          const sep = fallbackUrl.includes('?') ? '&' : '?';
          rewriteTable.set(spec, `${fallbackUrl}${gen > 0 ? `${sep}wstack_reload=${gen}` : ''}`);
        }
        continue;
      }
      if (spec === '@wrongstack/plugin-sdk') {
        rewriteTable.set(spec, './sdk-bridge.mjs');
        continue;
      }
      const hostPkg = resolveHostPackageSpecifier(spec);
      if (hostPkg) {
        rewriteTable.set(spec, pathToFileURL(hostPkg).href);
      }
    }

    const rewritten = stripped.replace(
      specifierPattern,
      (_full, prefix: string, spec: string, suffix: string) => {
        const mapped = rewriteTable.get(spec);
        return mapped ? `${prefix}${mapped}${suffix}` : `${prefix}${spec}${suffix}`;
      },
    );

    const withSourceUrl = `${rewritten}\n//# sourceURL=${pathToFileURL(canonical).href}\n`;
    const outAbsPath = resolve(tempDir, outName);
    pendingWrites.push(writeFile(outAbsPath, withSourceUrl, { encoding: 'utf8', mode: 0o600 }));
    return outName;
  };

  try {
    const entryRelOut = await emitLocalModule(normalizedEntry);
    await Promise.all(pendingWrites);
    return await import(pathToFileURL(resolve(tempDir, entryRelOut)).href);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
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
  const localClosureFiles = new Set<string>([resolve(entryPath).replaceAll('\\', '/')]);
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
              const resolvedLocal = resolveLocalRelativeFile(
                args.resolveDir || dirname(entryPath),
                spec,
              );
              if (resolvedLocal) {
                localClosureFiles.add(resolve(resolvedLocal).replaceAll('\\', '/'));
                if (localClosureFiles.size > MAX_PLUGIN_CLOSURE_FILES) {
                  throw new Error(
                    `Plugin relative import closure exceeds maximum of ${MAX_PLUGIN_CLOSURE_FILES} local files (${entryPath})`,
                  );
                }
              }
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

    if (isTsEntry && (!bunGlobal || typeof opts.stripTypeScriptTypes === 'function')) {
      if (gen > 0) evictRuntimeModuleCache(importTarget, opts.pluginDirectory);
      return importTypeScriptViaNodeFallback(entryPath, gen, {
        stripTypeScriptTypes: opts.stripTypeScriptTypes,
      });
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
