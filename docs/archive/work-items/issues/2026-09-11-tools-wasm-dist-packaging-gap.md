# @wrongstack/tools ships without vendored tree-sitter wasm — silent regex fallback

**Filed:** 2026-09-11  
**Scope:** `scripts/build-package.mjs` (tools build profile), `packages/tools/src/codebase-index/wasm/`, `packages/tools/src/codebase-index/tree-sitter-parser.ts`, `scripts/check-tree-sitter-wasm.mjs`  
**Method:** Static source inspection during the follow-up proof-driven bug-hunt campaign (VF-30 integrity-gate audit). No code changed.  
**Status:** Open — pre-existing packaging gap, documented during the campaign; confirmed uncorrected as of this filing.

---

## Summary

The published `@wrongstack/tools` package never ships the vendored tree-sitter wasm assets, so the codebase-index parser's lazy first-load verification finds no manifest in `dist/` and **silently falls back to the regex parser**. Every npm-installed consumer of `@wrongstack/tools` therefore gets degraded codebase-index parse quality (regex heuristics instead of tree-sitter AST) with no hard failure, while CI stays green — the integrity gate verifies `src/` only.

---

## Root cause

`scripts/build-package.mjs` builds the tools package in two steps:

1. **esbuild** bundles the JavaScript entries declared in the tools build profile.
2. **tsc** emits public declarations.

Neither step copies the vendored asset directory `packages/tools/src/codebase-index/wasm/` (13 grammars + `tree-sitter-runtime.wasm`) into `dist/`. There is no `postBuild` copy, no `staticAssets` list in the tools build profile, and no other step in the build pipeline that materializes the grammars next to the bundled code.

`tree-sitter-parser.ts` resolves the wasm files relative to its own compiled location (`dist/codebase-index/…`) and, per its documented contract, runs the same sha256 verification as `check-tree-sitter-wasm.mjs` lazily at first load of each grammar — treating an absent manifest as *skip*, with a regex fallback and a warning. Published installs take that branch every time.

---

## Impact

- **Silent quality degradation, no failure.** Indexed parsing in npm-installed environments uses the regex fallback for all 13 languages. Nothing throws; the only signal is the runtime warning.
- **CI cannot see it.** `check-tree-sitter-wasm.mjs` verifies the committed `src/` bytes against `wasm/checksums.json` — that gate passes because `src/` is intact. The gap is between `src/` and `dist/`, which no current check covers.
- **In-repo runs are unaffected.** Source-tree executions resolve the wasm from `src/` and get real tree-sitter parsing, which is why the gap is invisible in local development.

---

## Evidence

- `scripts/build-package.mjs` tools build profile: esbuild entries + tsc declarations + `postBuild` hooks — no wasm/static-asset copy step (audited 2026-09-11).
- `packages/tools/src/codebase-index/tree-sitter-parser.ts`: lazy first-load sha256 verification against the manifest relative to the compiled module; absent manifest → regex fallback + warning (documented in-file; VF-30).
- `scripts/check-tree-sitter-wasm.mjs`: verifies `packages/tools/src/codebase-index/wasm/` against `wasm/checksums.json` — scope is `src/` only.
- VF-30 conventions memory (2026-08-29): the gap was flagged as pre-existing and uncorrected when the integrity gate was audited.

---

## Fix directions

1. **Copy the grammars in the build.** Add a `postBuild` step to the tools profile in `scripts/build-package.mjs` that copies `src/codebase-index/wasm/` → `dist/codebase-index/wasm/` (recursive), mirroring the dist-relative lookup the parser already performs. This is the minimal fix and re-arms the runtime's lazy verification automatically.
2. **Keep the src/ gate.** `check-tree-sitter-wasm.mjs` remains the integrity gate for the committed bytes; the dist copy must never be hand-edited.
3. **Optionally assert dist presence in CI.** After the copy lands, a cheap CI assertion (manifest exists at `packages/tools/dist/codebase-index/wasm/checksums.json` and matches) would catch a future assets move loudly instead of silently degrading published installs again.
4. **Note the published surface.** `files` in `packages/tools/package.json` already publishes `dist/`; once the copy lands, the grammars ride along. Confirm the package size delta is acceptable (13 grammars ≈ a few MB) before releasing.

---

## Origin

Documented during the follow-up proof-driven bug-hunt campaign (round 13, 2026-09-11) while auditing the VF-30 integrity gate; flagged as pre-existing and uncorrected in the VF-30 conventions memory. The check-* family itself (all 16 checkers, including `check-tree-sitter-wasm.mjs`) audited clean — this gap lives in the build pipeline, not in any checker.
