import {
  File,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileText,
  FileType,
} from 'lucide-react';

// ── File icon by extension ────────────────────────────────────────────

const EXT_ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  // ── Code ──
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  // ── Data / config ──
  json: FileJson,
  lock: FileLock,
  // ── Styles ──
  css: FileText,
  scss: FileText,
  less: FileText,
  // ── Markup ──
  html: FileType,
  htm: FileType,
  svg: FileImage,
  xml: FileType,
  // ── Docs ──
  md: FileText,
  mdx: FileText,
  txt: FileText,
  // ── Config / data formats ──
  yml: FileText,
  yaml: FileText,
  toml: FileCog,
  env: FileCog,
  gitignore: FileCog,
  editorconfig: FileCog,
  // ── Scripts ──
  sh: FileCode,
  bash: FileCode,
  zsh: FileCode,
  fish: FileCode,
  ps1: FileCode,
  bat: FileCode,
  // ── Python ──
  py: FileCode,
  pyi: FileCode,
  pyx: FileCode,
  // ── Rust ──
  rs: FileCode,
  // ── Go ──
  go: FileCode,
  // ── Other languages ──
  rb: FileCode,
  java: FileCode,
  c: FileCode,
  cpp: FileCode,
  h: FileCode,
  hpp: FileCode,
  sql: FileCode,
  graphql: FileCode,
  // ── Images ──
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
  ico: FileImage,
};

/**
 * Returns a semantic Tailwind text-color class for a file extension.
 * The classes resolve through WebUI theme tokens so file icons adapt to
 * light/dark mode and the selected product palette.
 */
export function fileIconColor(name: string, isDirectory: boolean): string {
  if (isDirectory) {
    const lower = name.toLowerCase();
    if (lower === '.git') return 'text-primary/80';
    if (lower === 'node_modules') return 'text-destructive/70';
    if (lower === 'src' || lower === 'lib' || lower === 'packages') return 'text-warning/80';
    if (lower === 'tests' || lower === 'test' || lower === '__tests__') return 'text-success/80';
    if (lower === 'dist' || lower === 'build' || lower === '.next')
      return 'text-muted-foreground/70';
    return 'text-warning/80';
  }

  const ext = name.split('.').pop()?.toLowerCase() ?? '';

  if (/^(ts|tsx|js|jsx|mjs|cjs|py|pyi|pyx|go)$/.test(ext)) return 'text-info';
  if (/^(json|lock)$/.test(ext)) return 'text-warning';
  if (/^(css|scss|less|sass)$/.test(ext)) return 'text-accent-foreground';
  if (/^(html|htm|xml|svg|rb)$/.test(ext)) return 'text-destructive';
  if (/^(md|mdx|png|jpe?g|gif|webp|ico)$/.test(ext)) return 'text-primary';
  if (/^(yml|yaml|toml|env)$/.test(ext)) return 'text-success';
  if (/^(sh|bash|zsh|fish|ps1|bat|rs)$/.test(ext)) return 'text-brand-orange';
  if (/^(c|h|cpp|hpp|cc|hh)$/.test(ext)) return 'text-muted-foreground/80';

  // ── Config files ──
  if (/^(gitignore|editorconfig|prettierrc|eslintrc)$/.test(ext)) return 'text-muted-foreground/75';

  return 'text-muted-foreground';
}

export function fileIcon(name: string): React.ComponentType<{ className?: string }> {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return EXT_ICONS[ext] ?? File;
}
