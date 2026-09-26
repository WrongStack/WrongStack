## Conventions

- Before treating any `@wrongstack/simpleui` grep hit as a real import, open `packages/cli/src/simpleui-dist.ts` and confirm what it actually does. That file is the one in-repo consumer that *looks* like a barrel consumer but is not.
- Read `resolvePackageJson('@wrongstack/simpleui/package.json')` in that file as a **path-string resolution for static-asset serving**, not a module import. The CLI locates the package on disk to serve its built Vite `dist/` output; it never loads the barrel.
- Treat `packages/simpleui/src/index.ts` as having zero in-repo importers *by design*. The package's only in-repo consumption path is the built `dist/` asset, so an empty importer set is the expected state, not a finding.

## When exploring the dependency graph

- Stop traversal at the `@wrongstack/simpleui` boundary: follow it as a terminal asset edge to `dist/`, not as a module edge into `packages/simpleui/src`.
- Do not report the simpleui barrel as dead code, an unused export, or a missing consumer. Report it that way only if you have first ruled out the `simpleui-dist.ts` asset path.
- When a grep for `@wrongstack/simpleui` returns hits, classify each as either (a) the `resolvePackageJson` path string in `packages/cli/src/simpleui-dist.ts`, or (b) a genuine import. Only (b) is a code dependency.

## Pitfalls

- A raw `grep` result showing `wrongstack/simpleui/package.json` is a path literal inside `resolvePackageJson(...)`; do not read it as a dynamic `require`/`import` of the package.
- Do not infer module coupling from the shared `@wrongstack` scope. Scope similarity is not an import edge here.
