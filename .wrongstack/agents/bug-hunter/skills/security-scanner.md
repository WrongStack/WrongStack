## Plugin Trust

- In `packages/core/src/plugin/trust.ts`, inspect `hashLocalImportClosure` before reporting plugin pins as entry-only, under-scanned, or bypasses.
- For entries directly under a shared discovery root, expect `hashPluginDirectoryClosure(entry, discoveryRoots)` to hash the entry plus transitively resolved relative imports.
- For entries isolated in their own plugin directory, expect the sorted `relpath\0size\0sha256` directory manifest format.
- Do not re-flag dependency-free single-file bare hex pins as bypasses; that legacy format intentionally preserves existing valid pins.
