#!/usr/bin/env node
/**
 * WrongStack package builder.
 *
 * JavaScript is bundled with esbuild; public declarations are emitted by the
 * repository's TypeScript compiler. Keeping these two jobs separate avoids a
 * declaration-bundler dependency on TypeScript's private compiler API.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative } from 'node:path';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const packageRoot = process.cwd();
const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const packageExternals = Object.keys({
  ...(packageJson.dependencies ?? {}),
  ...(packageJson.optionalDependencies ?? {}),
  ...(packageJson.peerDependencies ?? {}),
});

const workspaceExternalPlugin = {
  name: 'externalize-wrongstack-workspace',
  setup(builder) {
    builder.onResolve({ filter: /^@wrongstack\// }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

function outputName(source) {
  const withoutSrc = source.replace(/^src[\\/]/, '');
  return withoutSrc.slice(0, -extname(withoutSrc).length).replaceAll('\\', '/');
}

function entryMap(sources) {
  return Object.fromEntries(sources.map((source) => [outputName(source), source]));
}

const coreEntries = entryMap([
  'src/index.ts',
  'src/kernel/index.ts',
  'src/types/index.ts',
  'src/defaults/index.ts',
  'src/utils/index.ts',
  'src/utils/expect-defined.ts',
  'src/utils/error.ts',
  'src/execution/prompt-enhancer.ts',
  'src/execution/index.ts',
  'src/coordination/index.ts',
  'src/storage/index.ts',
  'src/security/index.ts',
  'src/models/index.ts',
  'src/infrastructure/index.ts',
  'src/observability/index.ts',
  'src/tools/index.ts',
  'src/extension/index.ts',
  'src/hq/index.ts',
  'src/skills/index.ts',
  'src/tasking/index.ts',
]);

const toolEntries = entryMap([
  'src/index.ts',
  'src/builtin.ts',
  'src/browser/index.ts',
  'src/pack.ts',
  'src/read.ts',
  'src/write.ts',
  'src/edit.ts',
  'src/replace.ts',
  'src/glob.ts',
  'src/grep.ts',
  'src/bash.ts',
  'src/exec.ts',
  'src/fetch.ts',
  'src/search.ts',
  'src/todo.ts',
  'src/git.ts',
  'src/patch.ts',
  'src/json.ts',
  'src/diff.ts',
  'src/tree.ts',
  'src/lint.ts',
  'src/format.ts',
  'src/typecheck.ts',
  'src/test.ts',
  'src/languages/index.ts',
  'src/install.ts',
  'src/audit.ts',
  'src/outdated.ts',
  'src/logs.ts',
  'src/document.ts',
  'src/scaffold.ts',
  'src/tool-search.ts',
  'src/tool-use.ts',
  'src/batch-tool-use.ts',
  'src/tool-help.ts',
  'src/memory.ts',
  'src/mode.ts',
  'src/design.ts',
  'src/kanban.ts',
  'src/plan.ts',
  'src/ps-slash.ts',
  'src/skill.ts',
  'src/task.ts',
  'src/session-kanban.ts',
  'src/process-registry.ts',
  'src/circuit-breaker.ts',
  'src/tool-icons.ts',
  'src/tool-summary.ts',
  'src/tool-diff.ts',
  'src/next-steps.ts',
  'src/codebase-index/index.ts',
  'src/codebase-index/worker.ts',
]);

function pluginEntries() {
  const entries = { index: 'src/index.ts' };
  for (const subpath of Object.keys(packageJson.exports ?? {})) {
    if (!subpath.startsWith('./') || subpath === './package.json') continue;
    const name = subpath.slice(2);
    entries[name] = `src/${name}/index.ts`;
  }
  return entries;
}

const standard = (external = []) => ({
  entries: { index: 'src/index.ts' },
  external,
});

const profiles = {
  '@wrongstack/acp': {
    entries: {
      index: 'src/index.ts',
      client: 'src/client/index.ts',
      agent: 'src/agent/index.ts',
      sdk: 'src/sdk.ts',
      'wrongstack-acp-agent': 'src/agent/wrongstack-acp-agent.ts',
    },
    workspaceExternal: true,
  },
  '@wrongstack/bench': standard(['@wrongstack/core']),
  '@wrongstack/cli': {
    ...standard(['ws']),
    workspaceExternal: true,
    banner: '#!/usr/bin/env node',
  },
  '@wrongstack/core': { entries: coreEntries },
  '@wrongstack/kanban': standard(),
  '@wrongstack/mcp': standard(['@wrongstack/core']),
  '@wrongstack/plug-lsp': {
    entries: entryMap(['src/index.ts', 'src/setup.ts']),
    external: ['@wrongstack/core', '@wrongstack/tools'],
  },
  '@wrongstack/plugins': {
    entries: pluginEntries,
    external: ['@wrongstack/core'],
    sourcemap: false,
  },
  '@wrongstack/providers': {
    entries: entryMap(['src/index.ts', 'src/oauth/index.ts']),
    external: ['@wrongstack/core'],
  },
  '@wrongstack/runtime': {
    entries: {
      index: 'src/index.ts',
      pack: 'src/pack.ts',
      host: 'src/host.ts',
      vision: 'src/vision.ts',
      clipboard: 'src/clipboard.ts',
      probe: 'src/local-llm-probe.ts',
    },
    external: ['@wrongstack/core'],
  },
  '@wrongstack/sdd': standard(['@wrongstack/core']),
  '@wrongstack/security-scanner': standard(['@wrongstack/core']),
  '@wrongstack/simpleui': {
    entries: { index: 'src/index.ts' },
    target: 'es2022',
    platform: 'browser',
    clean: false,
  },
  '@wrongstack/super-memory': standard(['@wrongstack/core', '@wrongstack/core/utils']),
  '@wrongstack/telegram': standard(['@wrongstack/core']),
  '@wrongstack/tools': {
    entries: toolEntries,
    external: ['@typescript/typescript6', '@wrongstack/core', '@wrongstack/kanban', 'node:sqlite'],
  },
  '@wrongstack/tui': {
    ...standard(['ink', 'react']),
    workspaceExternal: true,
  },
  '@wrongstack/webui-server': {
    entries: {
      index: 'src/index.ts',
      'server/entry': 'src/server/entry.ts',
      'server/handlers': 'src/server/handlers/index.ts',
    },
    postBuild: prependServerShebang,
  },
  '@wrongstack/webui': {
    entries: { index: 'src/main.tsx', types: 'src/types.ts' },
    target: 'es2022',
    platform: 'browser',
    clean: false,
    external: [
      'react',
      'react-dom',
      '@wrongstack/core',
      '@wrongstack/tools',
      '@wrongstack/webui-server',
      'tailwindcss',
      './index.css',
      '@fontsource-variable/ibm-plex-sans',
      '@fontsource/ibm-plex-mono',
    ],
    conditions: ['module', 'jsnext:main', 'jsnext'],
    mainFields: ['module', 'jsnext:main', 'main'],
    loader: {
      '.ttf': 'file',
      '.woff': 'file',
      '.woff2': 'file',
    },
    assetNames: 'assets/[name]-[hash]',
    postBuild: writeWebUiServerShim,
  },
  '@wrongstack/desktop': {
    declarations: false,
    target: 'es2024',
    builds: [
      {
        entries: {
          main: 'src/main/main.ts',
          'agent-bridge': 'src/main/agent-bridge.ts',
        },
        outdir: 'dist/main',
        format: 'esm',
        external: ['electron'],
      },
      {
        entries: {
          preload: 'src/main/preload.ts',
          'webui-preload': 'src/main/webui-preload.ts',
        },
        outdir: 'dist/preload',
        format: 'cjs',
        extension: '.cjs',
        external: ['electron'],
      },
    ],
  },
};

function prependServerShebang() {
  const path = join(packageRoot, 'dist/server/entry.js');
  const source = readFileSync(path, 'utf8');
  if (!source.startsWith('#!')) writeFileSync(path, `#!/usr/bin/env node\n${source}`);
}

function writeWebUiServerShim() {
  const outdir = join(packageRoot, 'dist/server');
  mkdirSync(outdir, { recursive: true });
  writeFileSync(
    join(outdir, 'index.js'),
    "export * from '@wrongstack/webui-server';\n" +
      "import { startWebUI } from '@wrongstack/webui-server';\n" +
      'export { startWebUI };\n',
  );
  writeFileSync(join(outdir, 'index.d.ts'), "export * from '@wrongstack/webui-server';\n");
}

function emitDeclarations(entries, outdir) {
  if (process.env.WRONGSTACK_SKIP_DTS === '1') return;

  const tsc = join(dirname(require.resolve('typescript/package.json')), 'bin', 'tsc');
  const args = [
    tsc,
    '--project',
    'tsconfig.json',
    '--declaration',
    '--declarationMap',
    '--emitDeclarationOnly',
    '--noEmit',
    'false',
    '--rootDir',
    'src',
    '--outDir',
    outdir,
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: packageRoot,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new Error(`Type declaration emit failed (exit ${result.status ?? 'unknown'})`);
  }

  for (const [name, source] of Object.entries(entries)) {
    const natural = join(packageRoot, outdir, `${outputName(source)}.d.ts`);
    const target = join(packageRoot, outdir, `${name}.d.ts`);
    if (natural === target || !existsSync(natural)) continue;
    mkdirSync(dirname(target), { recursive: true });
    const declaration = readFileSync(natural, 'utf8');
    let specifier = relative(dirname(target), natural)
      .replaceAll('\\', '/')
      .replace(/\.d\.ts$/u, '.js');
    if (!specifier.startsWith('.')) specifier = `./${specifier}`;
    const lines = [`export * from '${specifier}';`];
    if (/\bexport default\b/u.test(declaration)) {
      lines.push(`export { default } from '${specifier}';`);
    }
    writeFileSync(target, `${lines.join('\n')}\n`);
  }
}

async function bundle(config, defaults) {
  const entries = typeof config.entries === 'function' ? config.entries() : config.entries;
  const outdir = config.outdir ?? defaults.outdir ?? 'dist';
  await build({
    absWorkingDir: packageRoot,
    entryPoints: entries,
    outdir,
    bundle: true,
    format: config.format ?? defaults.format ?? 'esm',
    platform: config.platform ?? defaults.platform ?? 'node',
    target: config.target ?? defaults.target ?? 'es2023',
    sourcemap: config.sourcemap ?? defaults.sourcemap ?? true,
    treeShaking: true,
    splitting: false,
    // Match package-builder semantics: published runtime dependencies stay
    // external and are resolved through the package manager. This also avoids
    // duplicating workspace singletons and embedding native/CJS dependencies.
    external: [...packageExternals, ...(defaults.external ?? []), ...(config.external ?? [])],
    plugins:
      config.workspaceExternal || defaults.workspaceExternal ? [workspaceExternalPlugin] : [],
    banner: config.banner || defaults.banner ? { js: config.banner ?? defaults.banner } : undefined,
    outExtension: config.extension ? { '.js': config.extension } : undefined,
    conditions: config.conditions ?? defaults.conditions,
    mainFields: config.mainFields ?? defaults.mainFields,
    loader: config.loader ?? defaults.loader,
    assetNames: config.assetNames ?? defaults.assetNames,
    logLevel: 'info',
  });
  return { entries, outdir };
}

const profile = profiles[packageJson.name];
if (!profile) {
  throw new Error(`No package build profile registered for ${packageJson.name}`);
}

if (profile.clean !== false) rmSync(join(packageRoot, 'dist'), { recursive: true, force: true });

const builds = profile.builds ?? [profile];
const emitted = [];
for (const buildConfig of builds) emitted.push(await bundle(buildConfig, profile));

if (profile.declarations !== false) {
  const declarationBuild = emitted[0];
  emitDeclarations(declarationBuild.entries, declarationBuild.outdir);
}

await profile.postBuild?.();
console.log(`Built ${packageJson.name} with esbuild + TypeScript declarations.`);
