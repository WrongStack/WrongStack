import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncSurfaceTheme } from './sync-surface-theme';

const app = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(app, '../..');
const signals = [
  'primary',
  'primary-foreground',
  'ring',
  'running',
  'accent',
  'accent-foreground',
  'brand-orange',
];
const tokens = [
  ...signals,
  'background',
  'foreground',
  'card',
  'secondary',
  'muted-foreground',
  'border',
  'input',
  'destructive',
  'success',
  'warning',
  'info',
];
export function readBrandSource() {
  const registry = readFileSync(join(root, 'packages/webui/src/lib/palettes.ts'), 'utf8');
  // Comments inside a token block would otherwise be read as part of the next declaration.
  const css = readFileSync(join(root, 'packages/webui/src/index.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const labels = JSON.parse(
    readFileSync(join(root, 'packages/webui/src/i18n/locales/en/settings.json'), 'utf8'),
  ) as { general: Record<string, string> };
  const base: Record<string, Record<string, string>> = {};
  const overrides = new Map<string, Record<string, string>>();
  for (const match of css.matchAll(
    /(:root|\.dark)(?:\[data-palette="([^"]+)"\])?\s*\{([^}]+)\}/g,
  )) {
    const values = Object.fromEntries(
      [...match[3]!.matchAll(/--([\w-]+):\s*([^;]+);/g)]
        .filter((v) => tokens.includes(v[1]!))
        .map((v) => [v[1]!, v[2]!.trim()]),
    );
    if (!Object.keys(values).length) continue;
    const mode = match[1] === '.dark' ? 'dark' : 'light';
    if (match[2]) overrides.set(`${match[2]}:${mode}`, values);
    else base[mode] = values;
  }
  for (const mode of ['light', 'dark'])
    for (const token of tokens)
      if (!base[mode]?.[token]) throw Error(`Missing canonical ${mode} ${token}`);
  const palettes = [
    ...registry.matchAll(
      /\{\s*id:\s*'([^']+)',\s*labelKey:\s*'([^']+)',\s*swatch:\s*'([^']+)',\s*swatchSecondary:\s*'([^']+)',\s*\}/g,
    ),
  ].map((match) => {
    const id = match[1]!,
      labelKey = match[2]!.split('.').at(-1)!;
    const name = labels.general[labelKey];
    if (!name) throw Error(`Missing canonical label ${id}`);
    const modes = Object.fromEntries(
      ['light', 'dark'].map((mode) => {
        const values = id === 'signal' ? base[mode]! : overrides.get(`${id}:${mode}`);
        if (!values) throw Error(`Missing canonical ${id} ${mode}`);
        for (const token of signals)
          if (!values[token]) throw Error(`Missing canonical ${id} ${mode} ${token}`);
        return [mode, Object.fromEntries(signals.map((token) => [token, values[token]!]))];
      }),
    ) as Record<'light' | 'dark', Record<string, string>>;
    return { id, name, color: match[3]!, secondaryColor: match[4]!, ...modes };
  });
  if (!palettes.length) throw Error('No canonical brand palettes found');
  const defaultPalette = registry.match(/DEFAULT_PALETTE:\s*PaletteId\s*=\s*'([^']+)'/)?.[1];
  if (!palettes.some((p) => p.id === defaultPalette))
    throw Error('Missing canonical default palette');
  return { base, palettes, defaultPalette };
}
export function syncBrand() {
  const { base, palettes, defaultPalette } = readBrandSource();
  const header =
    '// Generated from the canonical brand tokens by scripts/sync-brand.ts. Do not edit.\n';
  writeFileSync(
    join(app, 'src/brand-palettes.ts'),
    header +
      `export const brandNeutrals = ${JSON.stringify(base, null, 2)} as const;\nexport const brandPalettes = ${JSON.stringify(palettes, null, 2)} as const;\nexport type BrandPaletteId = (typeof brandPalettes)[number]['id'];\nexport const brandDefaultPalette = ${JSON.stringify(defaultPalette)} as const;\n`,
  );
  const block = (selector: string, values: Record<string, string>) =>
    `${selector} {\n${Object.entries(values)
      .map(([name, value]) => `  --ws-${name}: ${value};`)
      .join('\n')}\n}\n`;
  let result =
    '/* Generated brand tokens only. No WebUI component or runtime styles are imported. */\n';
  result += block(':root', base['light']!) + block(':root[data-mode="dark"]', base['dark']!);
  for (const palette of palettes) {
    if (palette.id === 'signal') continue;
    result += block(
      `:root[data-palette="${palette.id}"]`,
      palette['light'] as Record<string, string>,
    );
    result += block(
      `:root[data-mode="dark"][data-palette="${palette.id}"]`,
      palette['dark'] as Record<string, string>,
    );
  }
  writeFileSync(join(app, 'src/brand-tokens.css'), result);
  for (const [source, target] of [
    ['packages/webui/public/wrongstack.svg', 'public/wrongstack.svg'],
    ['website/public/wrongstack-mark.svg', 'public/wrongstack-mark.svg'],
  ]) {
    const destination = join(app, target!);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(root, source!), destination);
  }
  syncSurfaceTheme();
  const format = spawnSync(
    process.execPath,
    [
      '--bun',
      'run',
      'biome',
      'format',
      '--write',
      'apps/desktop-v2/src/brand-palettes.ts',
      'apps/desktop-v2/src/brand-tokens.css',
      'apps/desktop-v2/src/surface-theme.css',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  if (format.status !== 0)
    throw Error(`Brand token formatting failed: ${format.stderr || format.stdout}`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) syncBrand();
