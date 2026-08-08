/**
 * Type declarations for vitest-core-aliases.mjs.
 *
 * Generates vitest `resolve.alias` entries for every divergent
 * `@wrongstack/core/*` sub-path export — i.e., exports whose source
 * path does not match the export name (e.g. `agent-catalog` →
 * `coordination/agents/`). Non-divergent sub-paths are handled by the
 * bare `@wrongstack/core` prefix alias and don't need individual entries.
 *
 * Usage in a package-local vitest.config.ts:
 *
 *   import { coreAliases } from '../../scripts/vitest-core-aliases.mjs';
 *
 *   export default defineConfig({
 *     resolve: {
 *       alias: {
 *         ...coreAliases(path.resolve(__dirname, '../core')),
 *       },
 *     },
 *     // ...
 *   });
 *
 * @param corePackageDir — absolute path to `packages/core` on disk.
 * @returns A record of `{ [alias: string]: string }` suitable for
 *          spreading into a vitest config's `resolve.alias`.
 */
export declare function coreAliases(corePackageDir: string): Record<string, string>;
