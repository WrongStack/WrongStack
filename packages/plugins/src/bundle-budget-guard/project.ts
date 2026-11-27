import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type EvidenceFinding,
  type ProjectCollectContext,
  type ProjectCollection,
  readJson,
  resolveWorkspaces,
} from '../evidence-analyzer/project.js';

const OUTPUT_DIRS = ['dist', 'build', 'out', '.next/static', '.output/public'];
const MAX_FILES = 20000;

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} kB`;
}

function budget(options: Record<string, unknown>, key: string, fallback: number): number {
  const value = options[key];
  return typeof value === 'number' && value > 0 ? value : fallback;
}

interface Asset {
  path: string;
  bytes: number;
}

async function collectAssets(
  root: string,
  dir: string,
  signal: AbortSignal,
  out: Asset[],
): Promise<void> {
  const queue = [dir];
  while (queue.length > 0 && out.length < MAX_FILES) {
    signal.throwIfAborted();
    const current = queue.shift()!;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(join(root, current), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = `${current}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') queue.push(path);
      } else if (entry.isFile() && /\.(?:[cm]?js|css|map|wasm)$/.test(entry.name)) {
        try {
          out.push({ path, bytes: (await lstat(join(root, path))).size });
        } catch {
          // Removed between listing and stat.
        }
      }
    }
  }
}

/** Size budgets over the build output already on disk (root and workspace packages). */
export async function collectBundleBudget(
  context: ProjectCollectContext,
): Promise<ProjectCollection> {
  const { root, signal, options } = context;
  const maxJs = budget(options, 'maxAssetKb', 500) * 1024;
  const maxCss = budget(options, 'maxCssKb', 150) * 1024;
  const rootPkg = await readJson(root, 'package.json');
  const bases = ['.', ...(rootPkg ? (await resolveWorkspaces(root, rootPkg)).packages : [])];
  const outputDirs: string[] = [];
  for (const base of bases) {
    for (const dir of OUTPUT_DIRS) {
      const path = base === '.' ? dir : `${base}/${dir}`;
      try {
        if ((await lstat(join(root, path))).isDirectory()) outputDirs.push(path);
      } catch {
        // No output here.
      }
    }
  }
  if (outputDirs.length === 0) {
    throw new Error(
      'bundle_budget_analyze found no build output (dist/, build/, out/, .next/static); build first, or pass a bundle report as content',
    );
  }
  // Size budgets are a browser concern: a server or library bundle in
  // packages/*/dist is not shipped to users. Output counts as browser output
  // when it holds an index.html or assets/ folder, or is a framework's static
  // client directory; `includeServerOutput: true` budgets everything.
  const includeServer = options['includeServerOutput'] === true;
  const browserDirs: string[] = [];
  for (const dir of outputDirs) {
    const isStatic = /(?:^|\/)(?:\.next\/static|\.output\/public)$/.test(dir);
    let browser = isStatic;
    for (const marker of ['index.html', 'assets']) {
      try {
        await lstat(join(root, dir, marker));
        browser = true;
      } catch {
        // Marker absent.
      }
    }
    if (browser || includeServer) browserDirs.push(dir);
  }
  if (browserDirs.length === 0) {
    throw new Error(
      `bundle_budget_analyze found only server/library output (${outputDirs.slice(0, 5).join(', ')}); set extensions.bundle-budget-guard.includeServerOutput to budget it, or pass a bundle report as content`,
    );
  }
  const assets: Asset[] = [];
  for (const dir of browserDirs) await collectAssets(root, dir, signal, assets);
  const findings: EvidenceFinding[] = [];
  const over = assets
    .filter((a) =>
      /\.css$/.test(a.path) ? a.bytes > maxCss : /\.[cm]?js$/.test(a.path) && a.bytes > maxJs,
    )
    .sort((a, b) => b.bytes - a.bytes);
  for (const asset of over) {
    const limit = /\.css$/.test(asset.path) ? maxCss : maxJs;
    findings.push({
      rule: 'asset over budget',
      severity: 'warning',
      file: asset.path,
      line: 0,
      excerpt: `${asset.path} is ${kb(asset.bytes)} (budget ${kb(limit)})`,
      advice: 'Find the dependency or import that grew it; code-split, lazy-load or replace it.',
    });
  }
  const maps = new Map<string, number>();
  for (const asset of assets) {
    if (!asset.path.endsWith('.map')) continue;
    const dir = browserDirs.find((d) => asset.path.startsWith(`${d}/`)) ?? '.';
    maps.set(dir, (maps.get(dir) ?? 0) + 1);
  }
  for (const [dir, count] of maps) {
    findings.push({
      rule: 'source maps in build output',
      severity: 'info',
      file: dir,
      line: 0,
      excerpt: `${count} .map file(s) in ${dir}`,
      advice:
        'Confirm the publish/deploy step excludes them unless public source maps are intended.',
    });
  }
  const code = assets.filter((a) => /\.(?:[cm]?js|css|wasm)$/.test(a.path));
  return {
    findings,
    inspected: browserDirs,
    facts: {
      assets: code.length,
      totalKb: Math.round(code.reduce((sum, a) => sum + a.bytes, 0) / 1024),
      largest: [...code]
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, 5)
        .map((a) => `${a.path} ${kb(a.bytes)}`),
      budgets: { maxAssetKb: maxJs / 1024, maxCssKb: maxCss / 1024 },
      ...(assets.length >= MAX_FILES ? { truncatedAt: MAX_FILES } : {}),
    },
    limitation:
      'Measured raw (uncompressed) sizes of build output already on disk; nothing was built. Budgets come from extensions.bundle-budget-guard.maxAssetKb / maxCssKb.',
  };
}
