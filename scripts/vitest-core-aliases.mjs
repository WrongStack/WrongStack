/**
 * Generates vitest `resolve.alias` entries for @wrongstack/core sub-path
 * exports whose source layout diverges from the export name.
 *
 * Most exports resolve correctly through the bare '@wrongstack/core' → 'src/'
 * prefix alias (e.g. './utils' → src/utils/, './types' → src/types/). But a
 * few exports have a dist/source path that does NOT match the export name —
 * these need explicit aliases or they resolve to a nonexistent directory.
 *
 * Known divergent exports:
 *   ./agent          → dist/core/index.js         (not src/agent/)
 *   ./agent-catalog  → dist/coordination/agents/   (not src/agent-catalog/)
 *
 * This helper reads packages/core/package.json at config-load time and
 * auto-detects divergence so new exceptions are picked up automatically.
 *
 * Usage from a sibling package (packages/X/vitest.config.ts):
 *   ...coreAliases(path.resolve(__dirname, '../core'))
 * Usage from the repo root (vitest.config.ts):
 *   ...coreAliases(path.resolve(__dirname, 'packages/core'))
 *
 * @param {string} corePackageDir  Absolute path to packages/core/.
 * @returns {Record<string, string>}  Alias map for resolve.alias.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function coreAliases(corePackageDir) {
  const corePkgPath = resolve(corePackageDir, 'package.json');
  const corePkg = JSON.parse(readFileSync(corePkgPath, 'utf8'));
  const aliases = /** @type {Record<string, string>} */ ({});

  const divergent = /** @type {Array<[string, string]>} */ ([]);

  for (const [exportKey, exportValue] of Object.entries(corePkg.exports)) {
    if (exportKey === '.' || exportKey === './package.json' || exportKey.includes('*')) continue;

    if (typeof exportValue !== 'object' || exportValue === null) continue;
    const importPath = /** @type {string | undefined} */ (exportValue.import);
    if (typeof importPath !== 'string') continue;

    // "./dist/coordination/agents/index.js" → "coordination/agents"
    const srcRel = importPath
      .replace(/^\.\/dist\//, '')
      .replace(/\.js$/, '')
      .replace(/\/index$/, '');

    // "./agent-catalog" → "agent-catalog"
    const exportRel = exportKey.slice(2); // strip leading "./"

    // Only alias when the source path diverges from the export name.
    // Matching exports (e.g. "./utils" → src/utils/) are handled by the
    // bare '@wrongstack/core' → src/ prefix alias — adding an explicit
    // alias for them would cause @rollup/plugin-alias prefix conflicts
    // (e.g. '@wrongstack/core/utils' would shadow
    // '@wrongstack/core/utils/sage-output-block').
    if (srcRel === exportRel) continue;

    const aliasKey = `@wrongstack/core/${exportRel}`;
    divergent.push([aliasKey, resolve(corePackageDir, 'src', srcRel)]);
  }

  // Sort by DESCENDING key length so longer aliases are checked first.
  // @rollup/plugin-alias does prefix matching in insertion order:
  // '@wrongstack/core/agent' would shadow '@wrongstack/core/agent-catalog'
  // (matching it as a prefix → 'src/core-catalog') if it came first.
  divergent.sort((a, b) => b[0].length - a[0].length);
  for (const [key, value] of divergent) {
    aliases[key] = value;
  }

  // Bare alias LAST: prefix-matching means '@wrongstack/core' catches any
  // sub-path that wasn't explicitly aliased above, resolving to
  // src/<sub-path> which Vite resolves to the .ts file.
  aliases['@wrongstack/core'] = resolve(corePackageDir, 'src');

  return aliases;
}
