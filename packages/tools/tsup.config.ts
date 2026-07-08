import { defineConfig } from 'tsup';

// L3-A: every public tool gets its own entry so users can
// `import { bashTool } from '@wrongstack/tools/bash'` and tree-shake the
// rest. Underscored files are excluded.
export default defineConfig({
  entry: [
    'src/index.ts',
    'src/builtin.ts',
    'src/pack.ts',
    // Public tool entry points — explicit list rather than a glob so
    // removing a tool doesn't silently break a public subpath.
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
    'src/process-registry.ts',
    'src/circuit-breaker.ts',
    // Pure-data tool icon identity (browser-safe; consumed by WebUI + TUI).
    'src/tool-icons.ts',
    // Pure tool-input summarizer (browser-safe; consumed by WebUI + HQ dashboard).
    'src/tool-summary.ts',
    // Pure tool-output diff model (browser-safe; consumed by WebUI + HQ dashboard).
    'src/tool-diff.ts',
    // Codebase index tools
    'src/codebase-index/index.ts',
    // Index worker thread — must be its own emitted file: the host spawns it
    // via `new Worker(new URL('./worker.js', import.meta.url))` at runtime.
    'src/codebase-index/worker.ts',
  ],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: 'es2023',
  // tsup strips the `node:` protocol by default (removeNodeProtocol: true),
  // which rewrites `node:sqlite` → `sqlite`. There is no `sqlite` npm package
  // (Node resolves `node:sqlite` natively, experimental since 22.5), so the
  // rewrite makes dist unloadable. Keep the protocol intact.
  removeNodeProtocol: false,
  external: [
    // Workspace dependency — resolved from node_modules at runtime.
    '@wrongstack/core',
    // Node built-in (codebase-index storage). Must not be inlined.
    'node:sqlite',
    // The TypeScript compiler API (used only by codebase-index/ts-parser).
    // Bundling it inlines ~9 MB of CJS that relies on `require`, `__filename`,
    // and `__dirname` — none of which exist in an ESM bundle, so the dist
    // crashes on load. Keep it external and ship it as a runtime dependency.
    'typescript',
  ],
});