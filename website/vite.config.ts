import fs from 'node:fs';
import path from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { injectWebsiteCsp } from './csp.mjs';

const baseRoutes = [
  'features',
  'how-it-works',
  'compare',
  'interfaces',
  'commands',
  'settings',
  'architecture',
  'ecosystem',
  'security',
  'getting-started',
  'workflows',
  'fleet',
  'modes',
  'agent-roster',
  'mailbox',
  'memory',
  'providers',
  'coding-plans',
  'mcp',
  'tools',
  'plugins',
  'troubleshooting',
  'brand',
  'created-by',
  'sage',
  'design-studio',
  'skills',
  'prompts',
  'sdd',
  'shadow-agent',
  'acp',
  'supervisor',
  'goal',
  'ensemble',
  'hq',
  'telegram',
  'collab',
  'sync',
  'checkpoints',
  'commit-workflow',
];

const websiteRoot = fs.existsSync(path.resolve(import.meta.dirname, 'src/data/content.ts'))
  ? import.meta.dirname
  : path.resolve(import.meta.dirname, '..', '..');

function sourceSection(source: string, startMarker: string, endMarker?: string) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Catalog guard could not find: ${startMarker}`);
  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length;
  if (endMarker && end < 0) throw new Error(`Catalog guard could not find: ${endMarker}`);
  return source.slice(start, end);
}

function captures(source: string, pattern: RegExp) {
  return [...source.matchAll(pattern)].map((match) => match[1]).filter(Boolean) as string[];
}

/**
 * Parses the website `commandRows` slice in `src/data/content-commands.ts`.
 *
 * Anchors on the row-opener shape `[ '/name', 'summary' ]` (followed by an
 * optional `,`) rather than any quoted slash string, so a `'/something'` in
 * the description column or in a future comment cannot be mistaken for a
 * command. Both `validateProductCatalog()` and `contentRoutes()` consume
 * this — keeping them on one parser is the whole point.
 */
function parseWebsiteCommands(source: string): string[] {
  const commandSource = source.includes('const commandRows')
    ? source
    : fs.readFileSync(path.resolve(websiteRoot, 'src/data/content-commands.ts'), 'utf8');
  const commandBlock = sourceSection(commandSource, 'const commandRows', 'const categories');
  // Anchor on the start of a tuple row: `[ '/<name>',`. This handles both one-line
  // and multiline summaries while avoiding quoted slash strings later in a row or comment.
  const names = [...commandBlock.matchAll(/^\s*\[\s*'\/([^']+)'\s*,/gm)].map(([, name]) => name);
  if (names.length === 0) {
    throw new Error(
      'Slash-command row parser matched 0 rows in website/src/data/content-commands.ts. ' +
        'Did `const commandRows` change shape, get renamed, or lose its tuple opener?',
    );
  }
  return names;
}

/**
 * Parses the `pluginCommands` Set declaration in `src/data/content-commands.ts`.
 *
 * This Set is the authoritative origin signal: every entry is a first-party
 * built-in plugin command. We use it (negated) to identify the set of Core
 * built-in commands in `commandRows`, which is the candidate pool for the
 * no-rich-detail whitelist. Anchoring on `new Set([` and trailing `])` keeps
 * the parse robust against refactors of the Set body.
 */
function parsePluginCommands(source: string): Set<string> {
  const commandSource = source.includes('const pluginCommands = new Set([')
    ? source
    : fs.readFileSync(path.resolve(websiteRoot, 'src/data/content-commands.ts'), 'utf8');
  const block = sourceSection(commandSource, 'const pluginCommands = new Set([', ']);');
  return new Set(captures(block, /'\/([^']+)'/g));
}

function assertSameCatalog(label: string, websiteValues: string[], runtimeValues: string[]) {
  const website = [...new Set(websiteValues)].sort();
  const runtime = [...new Set(runtimeValues)].sort();
  const missing = runtime.filter((value) => !website.includes(value));
  const stale = website.filter((value) => !runtime.includes(value));
  if (missing.length === 0 && stale.length === 0) return;
  throw new Error(
    [
      `${label} drifted from the runtime source.`,
      missing.length > 0 ? `Missing in website: ${missing.join(', ')}` : '',
      stale.length > 0 ? `No longer in runtime: ${stale.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

/**
 * The website intentionally presents runtime catalogs in a richer, hand-edited
 * form. Exact ids are still code-owned: fail the build when core adds/removes a
 * mode or fleet role without updating the corresponding operator page.
 */
function validateProductCatalog() {
  const repoRoot = path.resolve(import.meta.dirname, '..');
  const productSource = fs.readFileSync(
    path.resolve(websiteRoot, 'src/data/product-catalog.ts'),
    'utf8',
  );

  const modeSource = fs.readFileSync(
    path.join(repoRoot, 'packages/core/src/types/mode.ts'),
    'utf8',
  );
  const runtimeModeBlock = sourceSection(modeSource, 'export const DEFAULT_MODES', '\n];');
  const websiteModeBlock = sourceSection(
    productSource,
    'export const modeCatalog',
    'export type RosterBudget',
  );
  assertSameCatalog(
    'Session mode catalog',
    captures(websiteModeBlock, /\bid:\s*'([^']+)'/g),
    captures(runtimeModeBlock, /\bid:\s*'([^']+)'/g),
  );

  const phaseDir = path.join(repoRoot, 'packages/core/src/coordination/agents');
  const runtimePhaseRoles = fs
    .readdirSync(phaseDir)
    .filter((file) => /^phase\d.*\.ts$/.test(file))
    .flatMap((file) =>
      captures(fs.readFileSync(path.join(phaseDir, file), 'utf8'), /\brole:\s*'([^']+)'/g),
    );
  const fleetSource = fs.readFileSync(
    path.join(repoRoot, 'packages/core/src/coordination/fleet.ts'),
    'utf8',
  );
  const builtInFleetBlock = sourceSection(fleetSource, '', '// ACP external agents');
  const runtimeBuiltInRoles = [
    ...runtimePhaseRoles,
    ...captures(builtInFleetBlock, /defineAgent\('([^']+)'/g),
  ];
  const websitePhaseBlock = sourceSection(
    productSource,
    'export const rosterPhases',
    'export const specialRosterAgents',
  );
  const websiteSpecialBlock = sourceSection(
    productSource,
    'export const specialRosterAgents',
    'export const externalAcpAgents',
  );
  assertSameCatalog(
    'Built-in agent roster',
    [
      ...captures(websitePhaseBlock, /\brole:\s*'([^']+)'/g),
      ...captures(websiteSpecialBlock, /\brole:\s*'([^']+)'/g),
    ],
    runtimeBuiltInRoles,
  );

  const runtimeAcpBlock = sourceSection(fleetSource, '// ACP external agents');
  const websiteAcpBlock = sourceSection(productSource, 'export const externalAcpAgents');
  assertSameCatalog(
    'External ACP roster',
    captures(websiteAcpBlock, /\brole:\s*'([^']+)'/g),
    captures(runtimeAcpBlock, /defineAgent\('([^']+)'/g),
  );

  const runtimeCatalogSource = fs.readFileSync(
    path.resolve(websiteRoot, 'src/data/runtime-catalog.ts'),
    'utf8',
  );
  const websiteToolBlock = sourceSection(
    runtimeCatalogSource,
    'export const toolCatalog',
    'export const pluginSources',
  );
  const websiteToolNames = captures(websiteToolBlock, /(?:"name"|name):\s*['"]([^'"]+)['"]/g);
  const builtinToolsSource = fs.readFileSync(
    path.join(repoRoot, 'packages/tools/src/builtin.ts'),
    'utf8',
  );
  const builtinToolsBlock = sourceSection(builtinToolsSource, 'export const builtinTools', '\n];');
  const browserToolsSource = fs.readFileSync(
    path.join(repoRoot, 'packages/tools/src/browser/tools.ts'),
    'utf8',
  );
  const browserToolsBlock = sourceSection(browserToolsSource, 'export const browserTools', '\n];');
  const directBuiltinCount = captures(builtinToolsBlock, /^\s{2}(\w+Tool),$/gm).length;
  const browserBuiltinCount = captures(browserToolsBlock, /^\s{2}(browser\w+Tool),$/gm).length;
  const runtimeToolCount = directBuiltinCount + browserBuiltinCount;
  if (websiteToolNames.length !== runtimeToolCount) {
    throw new Error(
      `Built-in tool catalog drifted from the runtime source. Website: ${websiteToolNames.length}; runtime: ${runtimeToolCount}.`,
    );
  }

  // --- Count-drift guard -------------------------------------------------
  // Scan website source files for hardcoded count strings and verify they
  // match the canonical array lengths. Catches the "tool count changed but
  // someone forgot to update the homepage" class of drift at build time.
  const websiteCommandCount = parseWebsiteCommands(
    fs.readFileSync(path.resolve(websiteRoot, 'src/data/content-commands.ts'), 'utf8'),
  ).length;
  const utilsSource = fs.readFileSync(path.resolve(websiteRoot, 'src/lib/utils.ts'), 'utf8');
  const skillsBlock = sourceSection(utilsSource, 'export const skills', '] as const;');
  const runtimeSkillCount = captures(skillsBlock, /^\s*(?:\{\s*)?name:\s*'([^']+)'/gm).length;
  const runtimePluginCount = captures(
    sourceSection(runtimeCatalogSource, 'export const pluginCatalog'),
    /\bname:\s*'([^']+)'/g,
  ).length;

  const countChecks: Array<[number, string, RegExp]> = [
    [runtimeToolCount, 'tool', /(\d+)\s+built-in tools?/gi],
    [runtimeToolCount, 'tool', /All\s+(\d+)\s+(?:built-in\s+)?tools?/gi],
    [runtimeToolCount, 'tool', /tools\s*=\s*(\d+)/g],
    [runtimeSkillCount, 'skill', /(\d+)\s+(?:bundled\s+)?skills?/gi],
    [runtimePluginCount, 'plugin', /(\d+)\s+managed\s+plugins?/gi],
    [websiteCommandCount, 'command', /(\d+)\s+documented\s+(?:slash\s+)?commands?/gi],
  ];

  const websiteSrcFiles = [
    'index.html',
    'src/lib/utils.ts',
    'src/data/content.ts',
    'src/data/content-reference.ts',
    'src/pages/HomePage.tsx',
    'src/pages/ToolsPage.tsx',
    'src/pages/FeaturesPage.tsx',
    'src/pages/BrandPage.tsx',
    'src/pages/ToolDetailPage.tsx',
  ];
  for (const relPath of websiteSrcFiles) {
    const fullPath = path.resolve(websiteRoot, relPath);
    if (!fs.existsSync(fullPath)) continue;
    const fileContent = fs.readFileSync(fullPath, 'utf8');
    for (const [expected, label, pattern] of countChecks) {
      const matches = [...fileContent.matchAll(pattern)];
      for (const match of matches) {
        const stated = parseInt(match[1], 10);
        if (Number.isNaN(stated) || stated === expected) continue;
        // Only flag if the number is plausibly a count (not a CSS value, line number, etc.)
        // by checking it appears in a string literal or JSX text context
        const lineStart = fileContent.lastIndexOf('\n', match.index ?? 0) + 1;
        const lineEnd = fileContent.indexOf('\n', match.index ?? 0);
        const line = fileContent.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
        // Skip lines that look like CSS, comments about history, or changelog entries
        if (/^\s*\*|^\s*\/\//.test(line)) continue;
        if (/from 58 to 59|changelog|version|consolidat/i.test(line)) continue;
        if (/^(export const|import|const|let|var)\s/.test(line.trim())) continue;
        throw new Error(
          `Hardcoded ${label} count drift in ${relPath}:${lineStart}. ` +
            `Found "${stated}" but the canonical source has ${expected}. ` +
            `Line: ${line.trim().slice(0, 120)}`,
        );
      }
    }
  }

  const websitePluginBlock = sourceSection(runtimeCatalogSource, 'export const pluginCatalog');
  // The runtime audit list is split: the CLI host contributes
  // HOST_PLUGIN_AUDIT_ENTRIES and the plugins package owns
  // OFFICIAL_PLUGIN_AUDIT_ENTRIES; PLUGIN_AUDIT_ENTRIES is now just the frozen
  // concat of both, so parse the two source lists directly.
  // HOST_PLUGIN_AUDIT_ENTRIES lives in the plugin-audit-catalog package and
  // OFFICIAL_PLUGIN_AUDIT_ENTRIES lives in the plugins audit index.
  // PLUGIN_AUDIT_ENTRIES is the frozen concat of both, so parse the two
  // source lists directly.
  const pluginCatalogSource = fs.readFileSync(
    path.join(repoRoot, 'packages/plugins/src/plugin-audit-catalog/index.ts'),
    'utf8',
  );
  const hostPluginBlock = sourceSection(
    pluginCatalogSource,
    'export const HOST_PLUGIN_AUDIT_ENTRIES',
    '\n] as const;',
  );
  const officialAuditSource = fs.readFileSync(
    path.join(repoRoot, 'packages/plugins/src/audit/index.ts'),
    'utf8',
  );
  const officialPluginBlock = sourceSection(
    officialAuditSource,
    'export const OFFICIAL_PLUGIN_AUDIT_ENTRIES',
    '\n] as const;',
  );
  assertSameCatalog(
    'Managed plugin catalog',
    captures(websitePluginBlock, /(?:"name"|name):\s*['"]([^'"]+)['"]/g),
    [
      ...captures(hostPluginBlock, /\bname:\s*'([^']+)'/g),
      ...captures(officialPluginBlock, /\bname:\s*'([^']+)'/g),
    ],
  );

  // Slash-command catalog parity: every website command row should have a rich detail
  // page, and the curated set should be reviewed alongside the runtime registries whenever
  // /commands/<slug> routing breaks. We assert the rich-detail + dispatch coverage here
  // (one-directional: the website catalog cannot have an undocumented entry), without trying
  // to enumerate every runtime slash command from AST.
  const commandSource = fs.readFileSync(
    path.resolve(websiteRoot, 'src/data/content-commands.ts'),
    'utf8',
  );
  const websiteCommands = parseWebsiteCommands(commandSource);
  const pluginCommands = parsePluginCommands(commandSource);
  const detailsDir = path.resolve(websiteRoot, 'src/data');
  const detailsBlock = fs
    .readdirSync(detailsDir)
    .filter((file) => /^command-details(?:-part-\d+)?\.ts$/.test(file))
    .map((file) => fs.readFileSync(path.join(detailsDir, file), 'utf8'))
    .join('\n');
  // Anchor only on the slash-key shape; indentation of `command-details.ts` keys
  // is left to Prettier so a reformat cannot silently empty the capture set.
  const websiteDetails = captures(detailsBlock, /'\/([^']+)': \{/gm);
  if (websiteDetails.length === 0) {
    throw new Error(
      'Slash-command rich-detail parser matched 0 rows in website/src/data/command-details.ts. ' +
        "Did `commandDetails` change shape, get renamed, or lose its `'/<name>': {` row opener?",
    );
  }

  const uniq = (values: string[]) => [...new Set(values)].sort();
  // Derive the no-rich-detail whitelist from data, not a hand-maintained array.
  // The candidate pool is "Core built-ins in `commandRows`" — i.e. rows that
  // are NOT in the `pluginCommands` Set — intersected with rows that lack a
  // `command-details.ts` entry. The result is exactly the set of commands
  // intentionally shipped without a rich-detail page; renames in `commandRows`
  // and `pluginCommands` propagate automatically without a separate edit here.
  //
  // If a Core built-in row is added without a `command-details.ts` entry, this
  // guard will let it through (correct — it is intentionally no-detail). If a
  // row is later promoted to plugin origin by adding it to `pluginCommands`,
  // it falls out of the candidate pool (also correct — plugin commands get
  // their detail from their plugin source, not `command-details.ts`).
  const noRichDetailCommands: ReadonlySet<string> = new Set(
    uniq(websiteCommands)
      .filter((name) => !pluginCommands.has(name))
      .filter((name) => !websiteDetails.includes(name)),
  );
  const missingRichDetail = uniq(websiteCommands).filter(
    (name) => !websiteDetails.includes(name) && !noRichDetailCommands.has(name),
  );
  if (missingRichDetail.length) {
    throw new Error(
      `Website command rows without rich-detail entries (one-directional guard: website → command-details.ts only). ` +
        `Commands without rich detail (slug ${missingRichDetail
          .map((name) => `/commands/${commandSlug(name)}`)
          .join(', ')}) — add entries to src/data/command-details.ts.`,
    );
  }
}

/**
 * Build-time slug for a command row.
 *
 * Takes the BARE name (`mailbox`), not the display name (`/mailbox`) — every
 * build-time parser here (`parseWebsiteCommands`, `parsePluginCommands`, the
 * rich-detail capture) already strips the leading slash. The app-side
 * `commandSlug` in `src/data/content-commands.ts` takes the display name and
 * slices it off itself; calling this one with a bare name and slicing again
 * dropped the first letter of every route, so the prerendered directories and
 * every sitemap command URL read `/commands/ailbox` instead of
 * `/commands/mailbox`.
 */
function commandSlug(bareName: string) {
  return bareName.replace(/_/g, '-');
}

function contentRoutes() {
  const commandSource = fs.readFileSync(
    path.resolve(websiteRoot, 'src/data/content-commands.ts'),
    'utf8',
  );
  const featureSource = fs.readFileSync(
    path.resolve(websiteRoot, 'src/data/content-features.ts'),
    'utf8',
  );
  // Reuse the shared parser so drift-detection and route-generation stay on
  // one anchored regex. `parseWebsiteCommands()` throws on a zero-row match,
  // surfacing a `commandRows` shape change as a clean build error.
  const commands = parseWebsiteCommands(commandSource).map(
    (name) => `commands/${commandSlug(name)}`,
  );
  const features = [...featureSource.matchAll(/slug: '([^']+)'/g)].map(
    ([, slug]) => `features/${slug}`,
  );

  const runtimeSource = fs.readFileSync(
    path.resolve(websiteRoot, 'src/data/runtime-catalog.ts'),
    'utf8',
  );
  const pluginBlock = sourceSection(
    runtimeSource,
    'export const pluginCatalog',
    'export type PluginCatalogEntry',
  );
  const plugins = captures(pluginBlock, /\bname:\s*'([^']+)'/g).map(
    (name) => `plugins/${name.replace(/^@/, '').replace(/\//g, '-')}`,
  );
  const toolBlock = sourceSection(
    runtimeSource,
    'export const toolCatalog',
    'export const pluginSources',
  );
  const tools = captures(toolBlock, /\bname:\s*'([^']+)'/g).map(
    (name) => `tools/${name.replace(/_/g, '-')}`,
  );

  const productSource = fs.readFileSync(
    path.resolve(websiteRoot, 'src/data/product-catalog.ts'),
    'utf8',
  );
  const modeBlock = sourceSection(
    productSource,
    'export const modeCatalog',
    'export type RosterBudget',
  );
  const modes = captures(modeBlock, /\bid:\s*'([^']+)'/g).map((id) => `modes/${id}`);
  const agents = captures(productSource, /\brole:\s*'([^']+)'/g).map(
    (role) => `agent-roster/${role}`,
  );

  // Enforce the ASCII-only route invariant explicitly. The downstream
  // sitemap emitter relies on this contract, and `encodeURI` cannot turn an
  // XML-unsafe character (e.g. `<`, `>`, `&`) into a meaningful fix on its
  // own — it only percent-encodes what would otherwise be a bad URL. Catching
  // the violation at the route source means a stray emoji or a space in a
  // future tool/slug name fails the build with a clear message instead of
  // silently producing a malformed sitemap entry.
  const routes = [
    ...new Set([
      ...baseRoutes,
      ...commands,
      ...features,
      ...plugins,
      ...tools,
      ...modes,
      ...agents,
    ]),
  ];
  const unsafe = routes.filter((r) => /[^a-z0-9/_-]/.test(r));
  if (unsafe.length > 0) {
    throw new Error(
      `contentRoutes() produced non-ASCII-safe routes: ${unsafe.join(', ')}. ` +
        'Route segments must match [a-z0-9/_-]. Fix the offending source row in ' +
        'content.ts, runtime-catalog.ts, or product-catalog.ts.',
    );
  }
  return routes;
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'wrongstack-static-routes',
      buildStart() {
        validateProductCatalog();
      },
      closeBundle() {
        const outDir = path.resolve(import.meta.dirname, 'dist');
        const source = path.join(outDir, 'index.html');
        if (!fs.existsSync(source)) return;
        // WS-071: stamp the CSP onto the emitted HTML before it is fanned out
        // to the per-route copies below, so every route gets the same policy
        // from one write. Build-time rather than source-time because the dev
        // server injects its own inline refresh preamble, which no static hash
        // list can cover — see csp.mjs.
        fs.writeFileSync(source, injectWebsiteCsp(fs.readFileSync(source, 'utf8')), 'utf8');
        const routes = contentRoutes();
        // Enforce the ASCII-only route invariant at the emission site.
        // Routes are produced from regex captures over data files (`[^']+`)
        // and pass through slug transforms, but that contract lives across
        // multiple files (`content.ts`, `runtime-catalog.ts`, `product-catalog.ts`)
        // and is not enforced anywhere. `encodeURI` alone would silently emit
        // a malformed `<loc>` tag for a future tool or feature slug carrying
        // a non-ASCII character — fail the build here with a clear error
        // pointing at the offending route instead.
        const SAFE_ROUTE = /^[a-z0-9/_-]*$/;
        for (const route of ['', ...routes]) {
          if (!SAFE_ROUTE.test(route)) {
            throw new Error(
              `Sitemap route contains characters outside [a-z0-9/_-]: ${JSON.stringify(route)}. ` +
                'Check src/data/content.ts, src/data/runtime-catalog.ts and src/data/product-catalog.ts ' +
                'for tool, plugin, mode or agent names that leak non-safe characters.',
            );
          }
        }
        for (const route of routes) {
          const routeDir = path.join(outDir, route);
          fs.mkdirSync(routeDir, { recursive: true });
          fs.copyFileSync(source, path.join(routeDir, 'index.html'));
        }
        const urls = ['', ...routes]
          .map(
            (route) =>
              `  <url><loc>https://wrongstack.com/${encodeURI(route)}</loc><priority>${route ? '0.8' : '1.0'}</priority></url>`,
          )
          .join('\n');
        fs.writeFileSync(
          path.join(outDir, 'sitemap.xml'),
          `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`,
          'utf8',
        );
      },
    },
  ],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
});
