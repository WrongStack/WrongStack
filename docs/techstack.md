# Tech Stack Report — WrongStack Monorepo

**Generated**: 2026-07-11 · **Scanned**: 62 unique third-party packages across **22** `package.json` files

---

## Resolution update — 2026-07-11

- `@wrongstack/webui-hq` now uses Vite `^8.1.0` and `@vitejs/plugin-react ^6.0.0`; its object-form `manualChunks` config was migrated to the Vite 8/Rolldown function contract and the production build passes.
- The WebUI server no longer has a runtime `jszip` dependency. Skill exports use the built-in Node `zlib` implementation in `packages/webui-server/src/server/zip.ts`, including CRC validation and zip-slip rejection; round-trip tests cover Unicode, compression, empty archives, and unreadable skills.
- Root Node types, Vitest, and coverage packages were patched to current versions; WebUI test/build ranges were aligned. Biome remains exactly pinned to 2.5.2 because 2.5.3 promotes a new optional-chaining rule across historical tests and is not a no-risk patch.
- The monorepo now uses TypeScript 7.0.2. All `tsup` builds were replaced by a centralized esbuild + native `tsc --emitDeclarationOnly` driver. WrongStack tools that need the legacy compiler API use Microsoft's official `@typescript/typescript6` compatibility package side-by-side with the TS7 CLI.

## Current manifest state — 2026-07-15

- Repository version is `0.287.0` across the root, 19 `packages/*` manifests, both `apps/*` manifests, and the private website manifest.
- The repository contains **23 `package.json` files** total: root + 19 packages + 2 apps + website. The `pnpm` workspace itself contains 22 projects (19 packages + 2 apps + website); the root is the workspace root, not another workspace project.
- TypeScript remains `^7.0.2`; package builds use the centralized esbuild + native declaration-emit driver. No workspace manifest declares `tsup` or `jszip`.
- Root Vitest and coverage are aligned at `^4.1.10`; root Node types are `^26.1.1`. Biome remains exactly `2.5.2`.
- This is a manifest reconciliation, not a new npm-registry freshness scan. Registry “latest” values and status totals below remain evidence from 2026-07-11, not current recommendations.

The remainder of this document is the original 2026-07-11 scan snapshot, preserved for dated history. Its outdated/critical tables describe the pre-resolution manifests and are superseded by the two update sections above.

---

## Summary

| Status | Count |
|--------|-------|
| 🟢 Up to Date | **55** |
| 🟡 Outdated | **3** |
| 🔴 Critical Issues | **1** |
| ☠️ Dead / Obsolete | **0** |
| **Total** | **62** |

**Monorepo workspace packages**: 20 (`@wrongstack/*` + `wrongstack` + `wrongstack-website`) — all on `0.285.0`

---

## 🟢 Up to Date (55)

| Package | Current Range | Latest | Notes |
|---------|--------------|--------|-------|
| `@agentclientprotocol/sdk` | `^1.0.0` | 1.2.1 | Range covers latest |
| `@biomejs/biome` | `^2.5.2` | 2.5.3 | Patch gap only |
| `@fontsource-variable/ibm-plex-sans` | `^5.2.8` | 5.2.8 | Static font package |
| `@fontsource/ibm-plex-mono` | `^5.2.7` | 5.2.7 | Static font package |
| `@monaco-editor/react` | `^4.7.0` | 4.7.0 | Exact match |
| `@playwright/test` | `^1.61.1` / `^1.61.0` | 1.61.1 | Patch gap only |
| `@radix-ui/react-accordion` | `^1.2.14` | 1.2.16 | Patch gap only |
| `@radix-ui/react-dialog` | `^1.1.17` | 1.1.19 | Patch gap only |
| `@radix-ui/react-dropdown-menu` | `^2.1.18` | 2.1.20 | Patch gap only |
| `@radix-ui/react-label` | `^2.1.10` | 2.1.11 | Patch gap only |
| `@radix-ui/react-scroll-area` | `^1.2.12` | 1.2.14 | Patch gap only |
| `@radix-ui/react-separator` | `^1.1.10` | 1.1.11 | Patch gap only |
| `@radix-ui/react-slot` | `^1.3.0` | 1.3.0 | Exact match |
| `@radix-ui/react-tabs` | `^1.1.15` | 1.1.17 | Patch gap only |
| `@radix-ui/react-tooltip` | `^1.2.10` | 1.2.12 | Patch gap only |
| `@tailwindcss/vite` | `^4.3.1` | 4.3.2 | Patch gap only |
| `@testing-library/dom` | `^10.4.1` | 10.4.1 | Exact match |
| `@testing-library/react` | `^16.3.0` | 16.3.2 | Patch gap only |
| `@types/node` | `^26.1.0` / `^26.0.1` | 26.1.1 | Patch gap only |
| `@types/qrcode` | `^1.5.6` | 1.5.6 | Exact match |
| `@types/react` | `^19.2.x` / `^19.0.0` | 19.2.17 | All ranges cover latest |
| `@types/react-dom` | `^19.2.x` / `^19.0.0` | 19.2.3 | All ranges cover latest |
| `@types/ws` | `^8.18.1` / `^8.18.0` | 8.18.1 | Patch gap only |
| `@uiw/react-textarea-code-editor` | `^3.1.1` | 3.1.1 | Exact match |
| `@vitejs/plugin-react` | `^6.0.0` / `^6.0.3` | 6.0.3 | Current in webui & website |
| `@vitest/coverage-v8` | `^4.1.9` / `^4.1.0` | 4.1.10 | Patch gap only |
| `@xterm/addon-fit` | `^0.11.0` | 0.11.0 | Exact match |
| `@xterm/xterm` | `^6.0.0` | 6.0.0 | Exact match |
| `@xyflow/react` | `^12.11.1` | 12.11.2 | Patch gap only |
| `class-variance-authority` | `^0.7.1` | 0.7.1 | Stable, unmaintained since Nov 2024 |
| `clsx` | `^2.1.1` | 2.1.1 | Last release Apr 2024 |
| `cross-env` | `^10.1.0` | 10.1.0 | Exact match |
| `electron` | `^43.0.0` | 43.1.0 | Minor gap only |
| `framer-motion` | `^12.42.0` | 12.42.2 | Patch gap only |
| `i18next` | `^26.3.4` | 26.3.6 | Patch gap only |
| `i18next-resources-to-backend` | `^1.2.1` | 1.2.1 | Exact match |
| `ink` | `^7.1.0` | 7.1.0 | Exact match |
| `ink-testing-library` | `^4.0.0` | 4.0.0 | Exact match |
| `jsdom` | `^29.1.1` / `^29.1.0` | 29.1.1 | Patch gap only |
| `lucide-react` | `^1.22.0` | 1.24.0 | Range covers latest |
| `monaco-editor` | `^0.55.1` | 0.55.1 | Exact match |
| `next-themes` | `^0.4.6` | 0.4.6 | Exact match |
| `qrcode` | `^1.5.4` | 1.5.4 | Exact match |
| `react` | `^19.2.7` / `^19.0.0` | 19.2.7 | All ranges cover latest |
| `react-dom` | `^19.2.7` / `^19.0.0` | 19.2.7 | All ranges cover latest |
| `react-i18next` | `^17.0.8` | 17.0.9 | Patch gap only |
| `react-markdown` | `^10.1.0` | 10.1.0 | Exact match |
| `rehype-highlight` | `^7.0.2` | 7.0.2 | Exact match |
| `remark-gfm` | `^4.0.1` | 4.0.1 | Exact match |
| `tailwind-merge` | `^3.6.0` | 3.6.0 | Exact match |
| `tailwindcss` | `^4.3.1` | 4.3.2 | Patch gap only |
| `tsup` | `^8.5.1` / `^8.5.0` | 8.5.1 | Patch gap only |
| `turndown` | `^7.2.4` | 7.2.4 | Exact match |
| `undici` | `^8.5.0` | 8.7.0 | Range covers latest |
| `undici-types` | `^8.7.0` / `^8.5.0` | 8.7.0 | Range covers latest |
| `virtua` | `^0.49.1` | 0.49.3 | Patch gap only |
| `vitest` | `^4.1.9` / `^4.1.0` | 4.1.10 | Patch gap only |
| `vscode-languageserver-protocol` | `^3.18.1` | 3.18.2 | Patch gap only |
| `ws` | `^8.21.0` | 8.21.0 | Exact match |
| `zod` | `^4.4.3` | 4.4.3 | Exact match |
| `zustand` | `^5.0.14` | 5.0.14 | Exact match |

---

## 🟡 Outdated (3)

| Package | Current Range | Latest | Gap | Notes |
|---------|--------------|--------|-----|-------|
| `typescript` | `^6.0.3` / `^6.0.0` | **7.0.2** | Major (6→7) | TypeScript 7 is a breaking release. Verify compiler options, declaration output, `tsup` compatibility, and the full typecheck suite before upgrading. The entire monorepo pins `^6.x`. |
| `@vitejs/plugin-react` | `^4.3.0` | **6.0.3** | 2 major behind | Only `@wrongstack/webui-hq` uses this old range. The webui and website packages already use `^6.0.0`. Upgrade webui-hq to `^6.0.3` for consistency. |
| `vite` | `^6.0.0` | **8.1.4** | 2 major behind | Only `@wrongstack/webui-hq` pins `^6.0.0`. All other consumers (webui, website, desktop) use `^8.1.0`. Upgrade webui-hq to `^8.1.4`. |

---

## 🔴 Critical Issues (1)

| Package | Current Range | Latest | Issue |
|---------|--------------|--------|-------|
| `jszip` | `^3.10.1` | 3.10.1 | **Last release: August 2022 (~4 years ago).** While not officially deprecated, zero releases in 4 years indicate the project is in maintenance-only mode or abandoned. No known CVEs at this time. Consider replacing with native `CompressionStream` API (Node.js 22+ built-in) or `archiver`/`yazl` for active maintenance. |

---

## ☠️ Dead / Obsolete (0)

No package was marked deprecated or archived in registry metadata. No package exceeded the 5-year threshold for prehistoric classification.

---

## Special Notes & Caveats

| Package | Note |
|---------|------|
| `node-pty` (`1.1.0`, optional) | Re-pinned from `1.2.0-beta.14` prerelease to the latest stable (2026-09-01, security report Phase 4): the 1.1.0 prebuild resolves and passes the pty smoke check on Node 24 / ABI 137 with no compile step, so the prerelease channel is no longer needed. |
| `jszip` | See Critical Issues above. 4 years without a release. |
| `class-variance-authority` | Last release Nov 2024 (~8 months). Small utility; no activity but not deprecated. |
| `@types/ws` | Installed in both `^8.18.1` and `^8.18.0` across workspaces; align to `^8.18.1`. |

---

## Recommendations

### Top 5 Urgent Actions

1. **🔴 TypeScript 7 migration is the highest-impact item.** Plan and test TS 7.x on a branch:
   - Verify `tsc --noEmit` passes with the new compiler
   - Confirm `tsup` (v8.5.1) supports TS 7 output (it should — peer dep allows `>=4.5`)
   - Validate declaration output — TypeScript 7 changes module/type emit patterns
   - Pin root to `^7.0.2` after validation, then cascade to all 17 workspace packages

2. **🟡 Upgrade `@wrongstack/webui-hq` dependencies to match the rest of the monorepo:**
   - `vite`: `^6.0.0` → `^8.1.4`
   - `@vitejs/plugin-react`: `^4.3.0` → `^6.0.3`
   - `react`/`react-dom` `^19.0.0` is already compatible with `19.2.7`

3. **🔴 Evaluate `jszip` replacement.** Since Node.js 22 includes `CompressionStream` API natively (globally available without import), and the WebUI server only uses jszip for file downloads, consider replacing with the built-in `CompressionStream` or the actively maintained `archiver` package.

4. **Keep Vitest + Coverage synchronized.** Root pins `vitest@^4.1.9` and `@vitest/coverage-v8@^4.1.9`. The coverage peer depends on matching vitest major. Bump together to `4.1.10`.

5. **`node-pty` prerelease channel.** Resolved 2026-09-01: pinned to stable `1.1.0` after verifying empirically that its prebuild covers Node 24 / ABI 137 (see `scripts/check-node-pty.mjs`); revisit only if a future Node major regresses the prebuild.

### Additional Housekeeping

- **`@types/ws`** — Align `^8.18.0` (webui) to `^8.18.1` (everyone else).
- **Patch bumps available** — `@biomejs/biome 2.5.3`, `@types/node 26.1.1` — low-risk, batch with next dependency update.
- **Workspace version alignment** — `vitest` is `^4.1.9` in root but `^4.1.0` in `@wrongstack/webui`; `tsup` is `^8.5.1` in root but `^8.5.0` in webui. These are all within semver range but inconsistent.

---

## Cost Estimate (Optional)

| Category | Packages | Monthly Downloads (est.) |
|----------|----------|--------------------------|
| React ecosystem (Radix, xterm, xyflow, etc.) | ~25 | ~50M+ (collective) |
| Build tooling (tsup, vite, biome, vitest) | ~10 | ~60M+ (collective) |
| Runtime utilities (undici, ws, zod, etc.) | ~10 | ~100M+ (collective) |
| Test infrastructure (playwright, jsdom, etc.) | ~5 | ~30M+ (collective) |
| Desktop (electron) | 1 | ~5M |
| Fonts/static | 2 | ~1M |

**Estimated bundle size impact**: ~120 MB installed (node_modules), ~15 MB production (distributable after tree-shaking).

---

## Evidence & Methodology

- **Registry endpoint**: `https://registry.npmjs.org/<package>/latest` queried via `fetch` tool on 2026-07-11
- **Packages scanned**: 62 unique third-party packages extracted from 22 `package.json` files (root + 19 workspace packages + website + desktop)
- **Status criteria**:
  - 🟢 **CURRENT**: Latest version falls within the declared semver range
  - 🟡 **OUTDATED**: Latest version is outside the declared range (major gap)
  - 🔴 **CRITICAL**: >2 years without release OR known CVEs OR deprecated
  - ☠️ **DEAD**: Deprecated/archived/superseded >=5 years
- **Skipped** (HTTP 404): `@wrongstack/*` workspace packages (private/internal; excluded as instructed)
- **Security limitation**: npm registry `/latest` returns metadata, not CVE data. Run `pnpm audit --audit-level=moderate` separately for transitive vulnerability evidence.
