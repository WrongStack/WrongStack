import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { DEFAULT_WALK_IGNORE_DIRS } from '@wrongstack/core/utils';

export const DEFAULT_EXCLUDE_PATTERNS = [...DEFAULT_WALK_IGNORE_DIRS];

export interface GatherFilesOptions {
  root: string;
  extensions: string[];
  maxDepth: number;
  excludePatterns?: string[] | undefined;
  excludeHidden?: boolean | undefined;
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegex(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
  let source = '';
  for (let index = 0; index < normalized.length; index++) {
    const char = normalized[index];
    if (char === '*') {
      if (normalized[index + 1] === '*') {
        if (normalized[index + 2] === '/') {
          source += '(?:.*/)?';
          index += 2;
        } else {
          source += '.*';
          index++;
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += escapeRegex(char!);
    }
  }
  return new RegExp(`^(?:${source})$`);
}

export function shouldExcludeDir(
  name: string,
  relativePath: string,
  excludePatterns: string[] = DEFAULT_EXCLUDE_PATTERNS,
  excludeHidden = false,
): boolean {
  if (excludeHidden && name.startsWith('.')) return true;

  const normalizedPath = relativePath.replace(/\\/g, '/');
  return excludePatterns.some((rawPattern) => {
    const pattern = rawPattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (!pattern) return false;
    if (!pattern.includes('*') && !pattern.includes('?') && !pattern.includes('/')) {
      return name === pattern;
    }
    const matcher = globToRegex(pattern);
    return matcher.test(normalizedPath) || matcher.test(`${normalizedPath}/`);
  });
}

export async function gatherFiles(options: GatherFilesOptions): Promise<string[]> {
  const extensions = [...new Set(options.extensions.map((extension) => extension.toLowerCase()))];
  const files: string[] = [];

  async function visit(directory: string, currentDepth: number): Promise<void> {
    if (currentDepth > options.maxDepth) return;

    try {
      const entries = await readdir(directory, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));

      for (const entry of entries) {
        const fullPath = join(directory, entry.name);
        if (entry.isDirectory()) {
          const relativeDirectory = relative(options.root, fullPath).replace(/\\/g, '/');
          if (
            shouldExcludeDir(
              entry.name,
              relativeDirectory,
              options.excludePatterns,
              options.excludeHidden,
            )
          ) {
            continue;
          }
          await visit(fullPath, currentDepth + 1);
        } else if (
          entry.isFile() &&
          (extensions.length === 0 ||
            extensions.some((extension) => entry.name.toLowerCase().endsWith(extension)))
        ) {
          files.push(fullPath);
        }
      }
    } catch {
      // Inaccessible directories are intentionally skipped.
    }
  }

  await visit(options.root, 0);
  return files;
}
