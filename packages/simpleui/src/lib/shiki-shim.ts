/**
 * Build-time alias target for the bare `'shiki'' specifier.
 *
 * `rehype-pretty-code` imports `getSingletonHighlighter` from the `shiki`
 * root package, which drags the full bundle (~340 languages, ~100 themes,
 * oniguruma wasm — ~10MB) into the vendor chunk even though SimpleUI always
 * passes its own `getHighlighter`. `vite.config.ts` aliases `'shiki'` to this
 * module: it re-exports `shiki/core` and serves the singleton from the
 * curated fine-grained highlighter, removing the full bundle from the graph.
 *
 * If any other dependency starts importing more names from `'shiki'`, this
 * shim must grow matching exports — the build will fail loudly otherwise.
 */
export * from 'shiki/core';
export { getMarkdownHighlighter as getSingletonHighlighter } from './markdown-highlighter.js';
