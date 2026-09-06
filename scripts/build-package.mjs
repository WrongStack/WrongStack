#!/usr/bin/env node
/**
 * WrongStack package builder.
 *
 * JavaScript is bundled with esbuild; public declarations are emitted by the
 * repository's TypeScript compiler. Keeping these two jobs separate avoids a
 * declaration-bundler dependency on TypeScript's private compiler API.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, relative } from 'node:path';
import { build } from 'esbuild';
import { cleanBuildOutput } from './lib/build-output-cleanup.mjs';

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
  'src/core/index.ts',
  'src/statusline/index.ts',
  // Narrow, dependency-free entries so browser bundles (webui, webui-hq,
  // simpleui) can import these helpers without dragging the `types` / `core`
  // barrels — those reach `types/mode-prompts.ts`, which reads instruction
  // files with `node:fs` at module scope and made Vite externalize Node
  // built-ins into the browser graph.
  'src/core/model-ref.ts',
  'src/core/request-conversation-binding.ts',
  'src/types/index.ts',
  'src/types/session-markers.ts',
  'src/types/session-timeline.ts',
  'src/utils/index.ts',
  'src/utils/expect-defined.ts',
  'src/utils/error.ts',
  'src/utils/child-env.ts',
  'src/utils/sage-output-block.ts',
  'src/utils/tree-kill.ts',
  'src/utils/heap-watchdog.ts',
  'src/execution/prompt-enhancer.ts',
  'src/execution/index.ts',
  // Chimera review-report store: webui-server reads it per session tab, and
  // the core-api policy forbids new root-barrel imports — so it ships as its
  // own narrow entry next to the other dependency-free ones.
  'src/plugins/review-report-store.ts',
  'src/plugins/review-finding-store.ts',
  'src/plugins/review-finding-types.ts',
  'src/plugins/review-report-types.ts',
  'src/plugins/review-report-integration.ts',
  'src/design/index.ts',
  'src/coordination/index.ts',
  'src/coordination/agents/index.ts',
  'src/coordination/mailbox-project-server.ts',
  'src/registry/index.ts',
  'src/extension/index.ts',
  'src/plugin/index.ts',
  'src/chronicle/index.ts',
  'src/chronicle/project-server.ts',
  'src/session-catalog/index.ts',
  'src/session-catalog/project-server.ts',
  'src/storage/index.ts',
  'src/security/index.ts',
  'src/models/index.ts',
  'src/infrastructure/index.ts',
  'src/observability/index.ts',
  'src/notifications/index.ts',
  'src/tools/index.ts',
  'src/hq/index.ts',
  'src/hq/protocol.ts',
  'src/skills/index.ts',
  'src/tasking/index.ts',
  'src/prompts/index.ts',
  'src/performance/index.ts',
  'src/worktree/index.ts',
  'src/goal/index.ts',
  'src/hooks/index.ts',
  'src/replay/index.ts',
  // WrongProxy / WrongTrace rewriter. Listed here so esbuild emits
  // `dist/wiring/proxy-rewrite.{js,d.ts}`; without an explicit entry the
  // file is part of the source graph but never lands in `dist/`, and
  // consumers (`@wrongstack/cli`, `@wrongstack/runtime`) hit
  // ERR_PACKAGE_PATH_NOT_EXPORTED at runtime. The instant-apply rebuilder
  // (`createProxyInstantApply`) lives IN this module on purpose: a sibling
  // entry importing it relatively would be inlined per-entry, splitting
  // the ProxyConfig singleton + subscriber set into two instances.
  'src/wiring/proxy-rewrite.ts',
]);

const toolEntries = entryMap([
  'src/index.ts',
  'src/builtin.ts',
  'src/browser/index.ts',
  'src/pack.ts',
  'src/tool-tier.ts',
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
  'src/auto-proceed-loop-guard.ts',
  'src/win32.ts',
  'src/e2e.ts',
  'src/codebase-index/index.ts',
  'src/codebase-index/worker.ts',
  'src/codebase-index/project-server.ts',
  // Emitted standalone so the parser pool can spawn it from dist — without
  // this entry the pool's script probe finds nothing in built installs and
  // bulk parsing silently falls back to inline.
  'src/codebase-index/parser-worker-script.ts',
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
      v1: 'src/v1.ts',
      legacy: 'src/legacy.ts',
      'wrongstack-acp-agent': 'src/agent/wrongstack-acp-agent.ts',
    },
    workspaceExternal: true,
  },
  '@wrongstack/bench': standard(['@wrongstack/core']),
  '@wrongstack/cli': {
    ...standard(['ws']),
    workspaceExternal: true,
    banner: '#!/usr/bin/env node',
    // The CLI is the one bundle where deferring a workspace package actually
    // pays: it is loaded by every `wstack` invocation, including ones that only
    // print a version string. Single entry point, so chunking stays simple.
    splitting: true,
  },
  '@wrongstack/core': {
    entries: coreEntries,
    // MANDATORY, not an optimization. `core` publishes ~40 subpath entries and
    // with splitting OFF esbuild inlines every shared module into each one —
    // so `WrongStackError`, `ProviderError`, `AgentError` and every other
    // shared class existed once PER BUNDLE. `instanceof` then silently
    // returned false across a subpath boundary: a ProviderError thrown by
    // `@wrongstack/providers` (built against `core/types`) failed
    // `instanceof ProviderError` inside `core/core`, so `toWrongStackError`
    // flattened every provider failure to a shapeless AgentError. The fallback
    // engine stopped hopping, the provider waiting room was never written to,
    // and the recovery strategies in `execution/error-handler.ts` went dead —
    // all only in BUILT installs, which is why the source-level test suite
    // stayed green. Splitting emits ONE shared chunk, restoring a single class
    // identity (and a single module-level singleton) per process.
    splitting: true,
    // Root-level chunks — see the note on the `@wrongstack/tools` profile.
    chunkNames: '[name]-[hash]',
  },
  // `project-server` must be its own entry: client.ts spawns it via
  // `new URL('./project-server.js', import.meta.url)`, and `client.ts` is
  // bundled into `dist/index.js`. The entry key must NOT contain a `/` — esbuild
  // uses the key (not the source file's directory) for the output path, so the
  // daemon's spawn target resolves to `dist/project-server.js`.
  '@wrongstack/kanban': {
    entries: {
      index: 'src/index.ts',
      'contract-graph': 'src/contract-graph.ts',
      // Browser-safe leaf: the WebUI health bar imports it directly because the
      // barrel reaches the IPC client and drags `node:net` into the bundle.
      'queue-anomalies': 'src/queue-anomalies.ts',
      // Internal lifecycle seam re-exported as a directory module — the slash
      // command imports it from `@wrongstack/kanban/manager/lifecycle` to reach
      // the read-only preflight helpers without dragging the mutating
      // lifecycle source into the bundle. The key MUST keep the `/index` tail:
      // it is the output path, so a bare `manager/lifecycle` key would emit
      // `dist/manager/lifecycle.js` — which is not where the `exports` entry
      // points, AND whose `.d.ts` shim would overwrite the declarations tsc
      // emits for the sibling `src/manager/lifecycle.ts`, erasing the whole
      // lifecycle API (transitionTask and friends) from the barrel.
      'manager/lifecycle/index': 'src/manager/lifecycle/index.ts',
      'project-server': 'src/server/project-server.ts',
      'test-support': 'src/test-support.ts',
    },
    external: [],
  },
  '@wrongstack/persistence': standard(),
  // Dependency leaf (card #5): kanban sits below core/tools, so the shared
  // regex guard lives here where every tier can import it.
  '@wrongstack/primitives': standard(),
  '@wrongstack/vector-memory': standard(['@wrongstack/core', '@wrongstack/sage']),
  '@wrongstack/governance': {
    entries: {
      index: 'src/index.ts',
      'project-daemon': 'src/project-daemon.ts',
    },
    external: [],
  },
  '@wrongstack/mcp': standard(['@wrongstack/core']),
  '@wrongstack/plug-lsp': {
    entries: entryMap(['src/index.ts', 'src/setup.ts']),
    external: ['@wrongstack/core', '@wrongstack/tools'],
  },
  '@wrongstack/plugin-sdk': {
    // Granular runtime subpaths mirror the package.json exports entries:
    // single-symbol consumers (e.g. only `safePath` from sandbox) must not
    // pay the full 10-module runtime barrel on cold import. Entry names map
    // 1:1 onto src module paths, so tsc's per-module .d.ts lands exactly
    // where the exports map points (no shim overwrite — see the kanban
    // `manager/lifecycle` note for the counter-example shape).
    entries: {
      index: 'src/index.ts',
      runtime: 'src/runtime/index.ts',
      'runtime/bounded-map': 'src/runtime/bounded-map.ts',
      'runtime/credential-patterns': 'src/runtime/credential-patterns.ts',
      'runtime/h1-state': 'src/runtime/h1-state.ts',
      'runtime/handles': 'src/runtime/handles.ts',
      'runtime/llm': 'src/runtime/llm.ts',
      'runtime/local-bin': 'src/runtime/local-bin.ts',
      'runtime/redos-guard': 'src/runtime/redos-guard.ts',
      'runtime/safe-json': 'src/runtime/safe-json.ts',
      'runtime/sandbox': 'src/runtime/sandbox.ts',
    },
    // local-bin.ts imports + re-exports @wrongstack/tools/win32 — it must
    // stay external (like core) or the win32 helpers get silently bundled
    // while the emitted .d.ts still references the package.
    external: ['@wrongstack/core', '@wrongstack/tools'],
  },
  '@wrongstack/plugins': {
    entries: pluginEntries,
    external: ['@wrongstack/core', '@wrongstack/plugin-sdk'],
    sourcemap: false,
  },
  '@wrongstack/providers': {
    entries: entryMap(['src/index.ts', 'src/oauth/index.ts', 'src/provider-definitions.ts']),
    external: ['@wrongstack/core'],
  },
  '@wrongstack/runtime': {
    entries: {
      index: 'src/index.ts',
      pack: 'src/pack.ts',
      host: 'src/host.ts',
      'governance-bootstrap': 'src/governance-bootstrap.ts',
      'governance-sanitize': 'src/governance-sanitize.ts',
      'governance-mutation-snapshot-bridge': 'src/governance-mutation-snapshot-bridge.ts',
      vision: 'src/vision.ts',
      clipboard: 'src/clipboard.ts',
      probe: 'src/local-llm-probe.ts',
      'tool-registration': 'src/tool-registration.ts',
    },
    external: [
      '@wrongstack/core',
      '@wrongstack/governance',
      '@wrongstack/sage',
      '@wrongstack/tools',
    ],
  },
  '@wrongstack/sage': {
    entries: {
      index: 'src/index.ts',
      'project-server': 'src/project-server.ts',
      'middleware/tool-call-memory': 'src/middleware/tool-call-memory.ts',
    },
    external: ['@wrongstack/core', '@wrongstack/core/utils', '@wrongstack/persistence'],
  },
  '@wrongstack/sage-mcp': {
    entries: {
      index: 'src/index.ts',
      cli: 'src/cli.ts',
    },
    workspaceExternal: true,
    postBuild: prependMcpCliShebang,
  },
  '@wrongstack/kanban-mcp': {
    entries: {
      index: 'src/index.ts',
      cli: 'src/cli.ts',
    },
    workspaceExternal: true,
    postBuild: prependMcpCliShebang,
  },
  '@wrongstack/requirement-intake-mcp': {
    entries: {
      index: 'src/index.ts',
      cli: 'src/cli.ts',
    },
    workspaceExternal: true,
    postBuild: prependMcpCliShebang,
  },
  '@wrongstack/mailbox-mcp': {
    entries: {
      index: 'src/index.ts',
      cli: 'src/cli.ts',
    },
    workspaceExternal: true,
    postBuild: prependMcpCliShebang,
  },
  '@wrongstack/codebase-index-mcp': {
    entries: {
      index: 'src/index.ts',
      cli: 'src/cli.ts',
    },
    workspaceExternal: true,
    postBuild: prependMcpCliShebang,
  },
  '@wrongstack/sdd': standard(['@wrongstack/core']),
  '@wrongstack/security-scanner': standard(['@wrongstack/core']),
  '@wrongstack/techstack': standard(['@wrongstack/core', '@wrongstack/tools']),
  '@wrongstack/requirement-intake': standard(['@wrongstack/core']),
  '@wrongstack/simpleui': {
    entries: { index: 'src/index.ts' },
    target: 'es2022',
    platform: 'browser',
    clean: false,
    external: ['@wrongstack/core', '@wrongstack/webui-protocol'],
  },
  '@wrongstack/telegram': standard(['@wrongstack/core']),
  '@wrongstack/webui-protocol': standard(['@wrongstack/core']),
  '@wrongstack/tools': {
    entries: toolEntries,
    // Same reason as `@wrongstack/core`: 58 subpath entries with splitting OFF
    // gave every entry its own copy of `indexStorePool`, `indexCircuitBreaker`,
    // `languageProfileRegistry`, the project-server `connections` map and the
    // process registry — 12 independent copies of what the source treats as
    // one process-wide singleton. Splitting collapses them into one chunk.
    splitting: true,
    // Chunks live at the dist ROOT, not in a subdirectory. Several modules
    // locate sibling artifacts (daemon entry points, worker scripts, the
    // `instructions/` tree) with `new URL(rel, import.meta.url)`, and once
    // splitting moves that code into a chunk the chunk's own location is what
    // those relative paths resolve against. The dist root is the layout their
    // candidate lists already enumerate as the "root bundle" case, so keeping
    // chunks there needs no per-resolver special casing.
    chunkNames: '[name]-[hash]',
    external: [
      '@typescript/typescript6',
      '@wrongstack/core',
      '@wrongstack/kanban',
      '@wrongstack/persistence',
      'node:sqlite',
    ],
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
    external: ['@wrongstack/core', '@wrongstack/webui-protocol'],
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
      '@wrongstack/webui-protocol',
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

function prependMcpCliShebang() {
  const path = join(packageRoot, 'dist/cli.js');
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
  // Drive declarations from the package's tsconfig.json so every exported
  // subpath produces its own .d.ts tree under outDir. Falling back to a
  // bare `--rootDir src --emitDeclarationOnly` only emits the `index`
  // entry's declarations, which breaks subpath imports like
  // `@wrongstack/tools/tool-diff`. Browser packages (webui, simpleui)
  // override their tsconfig with `noEmit: true`, so they need a
  // dedicated declaration project.
  const dtsProject =
    packageJson.name === '@wrongstack/webui' || packageJson.name === '@wrongstack/simpleui'
      ? 'tsconfig.dts.json'
      : 'tsconfig.json';
  const args = [
    tsc,
    '--project',
    dtsProject,
    '--declaration',
    '--declarationMap',
    '--emitDeclarationOnly',
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: packageRoot,
    env: { ...process.env, NODE_OPTIONS: '--max-old-space-size=4096' },
    stdio: 'pipe',
    encoding: 'utf8',
  });
  // Forward tsc output so declaration diagnostics are visible in build logs.
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
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
  const format = config.format ?? defaults.format ?? 'esm';
  await build({
    absWorkingDir: packageRoot,
    entryPoints: entries,
    outdir,
    bundle: true,
    format,
    platform: config.platform ?? defaults.platform ?? 'node',
    target: config.target ?? defaults.target ?? 'es2023',
    sourcemap: config.sourcemap ?? defaults.sourcemap ?? true,
    treeShaking: true,
    // Opt-in per package. With splitting OFF, esbuild inlines every
    // dynamically-imported in-repo module into the single output file and
    // HOISTS that module's external imports to the top of the bundle — so an
    // `await import('./x.js')` where `x.ts` imports a workspace package does
    // not defer the package at all. Splitting emits real chunks, which is the
    // only way that boundary survives bundling.
    splitting: config.splitting ?? defaults.splitting ?? false,
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
    chunkNames: config.chunkNames ?? defaults.chunkNames,
    logLevel: 'info',
  });
  await stripBannerFromChunks(config, defaults, outdir, entries);
  return { entries, format, outdir };
}

function assertEsmNodeBuiltinsStayImportable({ format, outdir }) {
  if (format !== 'esm') return;
  const dir = join(packageRoot, outdir);
  const invalid = [];
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const source = readFileSync(absolute, 'utf8');
      if (/\b__require\(["']node:/u.test(source)) invalid.push(relative(packageRoot, absolute));
    }
  };
  walk(dir);
  if (invalid.length > 0) {
    throw new Error(
      `ESM build contains dynamic Node built-in require calls that fail at runtime:\n${invalid.map((file) => `- ${file}`).join('\n')}`,
    );
  }
}

/**
 * esbuild applies `banner` to EVERY output file, so with code splitting the
 * `#!/usr/bin/env node` shebang lands on each shared chunk too. Node tolerates
 * it, but a shebang is only meaningful on an executable entry point and it
 * confuses tools that re-read the chunks. Strip it from everything that is not
 * one of the declared entry outputs.
 */
async function stripBannerFromChunks(config, defaults, outdir, entries) {
  const banner = config.banner ?? defaults.banner;
  if (!banner?.startsWith('#!')) return;
  if (!(config.splitting ?? defaults.splitting ?? false)) return;

  const entryBasenames = new Set(Object.keys(entries).map((name) => `${name.split('/').pop()}.js`));
  const dir = join(packageRoot, outdir);
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      if (entryBasenames.has(entry.name)) continue;
      const source = readFileSync(absolute, 'utf8');
      if (!source.startsWith(banner)) continue;
      writeFileSync(absolute, source.slice(banner.length).replace(/^\r?\n/u, ''));
    }
  };
  walk(dir);
}

const profile = profiles[packageJson.name];
if (!profile) {
  throw new Error(`No package build profile registered for ${packageJson.name}`);
}

if (profile.clean !== false && process.env.WRONGSTACK_SKIP_CLEAN !== '1') {
  const distPath = join(packageRoot, 'dist');
  const cleanupResult = cleanBuildOutput(distPath);
  if (cleanupResult === 'retained-empty') {
    console.warn(`Reusing empty build directory still held open by Windows: ${distPath}`);
  }
}

const builds = profile.builds ?? [profile];
const emitted = [];
for (const buildConfig of builds) emitted.push(await bundle(buildConfig, profile));
for (const buildOutput of emitted) assertEsmNodeBuiltinsStayImportable(buildOutput);

if (profile.declarations !== false) {
  const declarationBuild = emitted[0];
  emitDeclarations(declarationBuild.entries, declarationBuild.outdir);
}

await profile.postBuild?.();
console.log(`Built ${packageJson.name} with esbuild + TypeScript declarations.`);
