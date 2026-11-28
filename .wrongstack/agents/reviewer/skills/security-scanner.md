## Conventions

- Write BOM-stripping regexes as the explicit escape `/^\uFEFF/`, never a raw U+FEFF or a lookalike codepoint (U+200B, U+2060). Match the established pattern in `packages/core/src`: `utils/config-json.ts`, `hq/alerts-config.ts`, `skills/manifest-store.ts`, `core/system-prompt-variants.ts` (`[applied 22×, 22 ok]`).
- Before approving any BOM change, run `rg -n '\uFEFF' <file>` and inspect the source escape itself — rendered diffs and grep output can hide an inert raw or lookalike codepoint that compiles and passes tests while stripping nothing.
- Escalate a failed BOM strip in `packages/core/src/security/secret-vault.ts` as a security defect, not style: plaintext secrets can remain on disk.

## Plugin trust digests

- In `packages/core/src/plugin/trust.ts`, require integrity/TOFU digests to fail **closed**. A `continue` on oversize or read error drops the file from the manifest, so tampering goes undetected and a fully skipped entry hashes the empty string into one shared constant digest. Demand a throw or an explicit sentinel entry per skip.
- When a diff adds an optional parameter to a pin/hash function, run `rg 'hashPluginDirectoryClosure(\|hashPluginClosure('` and confirm the pin site and every verify/load site pass identical arguments; an argument-dependent digest for the same file silently breaks verification across access shapes.
