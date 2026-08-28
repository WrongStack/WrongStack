import * as path from 'node:path';

const LANGUAGE_MAP: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.tsx': 'typescriptreact',
  '.js': 'javascript',
  '.jsx': 'javascriptreact',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.go': 'go',
  '.rs': 'rust',
  '.py': 'python',
  '.pyi': 'python',
  '.rb': 'ruby',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.lua': 'lua',
  '.zig': 'zig',
  '.php': 'php',
  '.json': 'json',
  '.html': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.sh': 'shellscript',
  '.bash': 'shellscript',
};

const FILENAME_MAP: Readonly<Record<string, string>> = {
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
  'CMakeLists.txt': 'cmake',
  'tsconfig.json': 'json',
  'package.json': 'json',
};

export function languageIdFor(filePath: string): string | null {
  const base = path.basename(filePath);
  const exact = FILENAME_MAP[base];
  if (exact) return exact;

  if (base.endsWith('.test.ts') || base.endsWith('.spec.ts')) return 'typescript';
  if (base.endsWith('.test.tsx') || base.endsWith('.spec.tsx')) return 'typescriptreact';
  if (base.endsWith('.test.js') || base.endsWith('.spec.js')) return 'javascript';
  if (base.endsWith('.test.jsx') || base.endsWith('.spec.jsx')) return 'javascriptreact';

  return LANGUAGE_MAP[path.extname(base)] ?? null;
}
