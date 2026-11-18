const LOCKFILE_BASENAMES = new Set([
  'bun.lock',
  'bun.lockb',
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'cargo.lock',
  'poetry.lock',
  'uv.lock',
  'pipfile.lock',
  'go.sum',
  'composer.lock',
  'gemfile.lock',
]);

const BUILD_DIR_SEGMENTS = new Set([
  'dist',
  'build',
  '.next',
  'out',
  'coverage',
  'node_modules',
  'target',
  '.turbo',
]);

const BINARY_OR_MEDIA_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.bmp',
  '.avif',
  '.pdf',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.otf',
  '.mp3',
  '.mp4',
  '.wav',
  '.ogg',
  '.webm',
  '.mov',
  '.zip',
  '.tar',
  '.gz',
  '.tgz',
  '.7z',
  '.wasm',
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.pyc',
  '.class',
]);

export const SOURCE_CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.rs',
  '.py',
  '.go',
  '.java',
  '.kt',
  '.swift',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.sql',
  '.sh',
  '.ps1',
  '.vue',
  '.svelte',
]);

/**
 * Classify generated, binary, lockfile, or internal paths that burn review
 * tokens without carrying reviewable source logic. Returns a concise detail
 * tag when the file should be skipped, or `null` when reviewable.
 */
export function isIgnoredReviewNoisePath(filePath: string): string | null {
  const normalized = filePath.replaceAll('\\', '/').replace(/^\.\/+/, '');
  const lower = normalized.toLowerCase();
  if (lower.startsWith('.wrongstack/') || lower === '.wrongstack') return 'internal_state';
  const segments = lower.split('/');
  const base = segments[segments.length - 1] ?? '';
  if (LOCKFILE_BASENAMES.has(base)) return 'lockfile';
  if (segments.slice(0, -1).some((seg) => BUILD_DIR_SEGMENTS.has(seg))) return 'build_artifact';
  if (base.endsWith('.snap')) return 'snapshot';
  if (base.endsWith('.map')) return 'sourcemap';
  if (
    base.endsWith('.min.js') ||
    base.endsWith('.min.mjs') ||
    base.endsWith('.min.css') ||
    base.endsWith('.bundle.js')
  ) {
    return 'minified';
  }
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx !== -1 && BINARY_OR_MEDIA_EXTENSIONS.has(base.slice(dotIdx))) {
    return 'binary_asset';
  }
  return null;
}

function candidateTier(filePath: string): number {
  const normalized = filePath.replaceAll('\\', '/').toLowerCase();
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  const isTest =
    /\.(?:test|spec)\.[a-z0-9]+$/.test(base) ||
    normalized.includes('/tests/') ||
    normalized.includes('/__tests__/');
  const dotIdx = base.lastIndexOf('.');
  const ext = dotIdx !== -1 ? base.slice(dotIdx) : '';
  if (SOURCE_CODE_EXTENSIONS.has(ext) && !isTest) return 0; // primary production code first
  if (SOURCE_CODE_EXTENSIONS.has(ext) && isTest) return 1; // test code second
  if (ext === '.css' || ext === '.scss' || ext === '.html') return 2; // UI markup/styles
  if (ext === '.json' || ext === '.yaml' || ext === '.yml' || ext === '.toml') return 3; // configs
  return 4; // docs / markdown / misc last
}

/**
 * Deterministically rank review candidates so source code files are never
 * crowded out by docs or JSON files when `maxFiles` caps a batch. Preserves
 * original relative order within each priority tier.
 */
export function prioritizeReviewCandidates<
  T extends { path: string; status: 'added' | 'modified' },
>(files: readonly T[], maxFiles: number): { selected: T[]; capped: T[] } {
  const cap = Math.max(1, maxFiles);
  const indexed = files.map((file, index) => ({ file, index, tier: candidateTier(file.path) }));
  indexed.sort((a, b) => a.tier - b.tier || a.index - b.index);
  return {
    selected: indexed.slice(0, cap).map((entry) => entry.file),
    capped: indexed.slice(cap).map((entry) => entry.file),
  };
}

export function normalizeReviewPath(filePath: string): string {
  // Locale-independent: under a Turkish locale `I` lowers to dotless `ı`.
  return filePath.replaceAll('\\', '/').toLowerCase();
}
