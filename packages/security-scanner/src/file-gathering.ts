import { open, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { DEFAULT_WALK_IGNORE_DIRS } from '@wrongstack/core/utils';

export const DEFAULT_EXCLUDE_PATTERNS = [...DEFAULT_WALK_IGNORE_DIRS];

/**
 * Bytes to read per requested UTF-16 code unit.
 *
 * The worst ratio is a 3-byte UTF-8 sequence (e.g. CJK), which decodes to a
 * single unit; 4-byte sequences cost more bytes but yield a surrogate pair, so
 * they are only 2 bytes per unit. Four therefore always over-reads slightly
 * rather than coming up short.
 */
const MAX_BYTES_PER_UTF16_UNIT = 4;

/**
 * Hard ceiling on `maxChars` accepted by `readFileHead`. The byte buffer is
 * sized as `maxChars * MAX_BYTES_PER_UTF16_UNIT`, so an unbounded `maxChars`
 * (e.g. `Number.MAX_SAFE_INTEGER` from a buggy caller) would make
 * `Buffer.allocUnsafe` allocate gigabytes and OOM the process. Internal callers
 * are capped at 2000 / 1000 chars, so 1 MiB of code units (→ ≤ 4 MiB bytes) is
 * a generous headroom that no legitimate caller approaches. Anything beyond
 * this is treated as a programming error and rejected loudly.
 */
const MAX_FILE_HEAD_CHARS = 1024 * 1024;

/**
 * Read at most the first `maxChars` UTF-16 code units of a file.
 *
 * Scan prompts only ever include a short head of each file, but reading the
 * whole file first meant a single minified bundle or lockfile pulled its full
 * size into memory just to have all but a couple of kilobytes thrown away.
 * Reading a bounded prefix caps that cost at the amount actually used.
 *
 * The limit counts code units so the result matches the `String.slice` this
 * replaced. The read itself is byte-bounded, so a multi-byte sequence can
 * straddle the end of the buffer; `StringDecoder` withholds that partial
 * sequence instead of emitting a replacement character.
 *
 * @throws RangeError when `maxChars` is not a non-negative integer or exceeds
 *   {@link MAX_FILE_HEAD_CHARS}. The ceiling exists to prevent a hostile or
 *   buggy caller from forcing a multi-gigabyte allocation through
 *   `Buffer.allocUnsafe`.
 */
export async function readFileHead(filePath: string, maxChars: number): Promise<string> {
  if (
    !Number.isFinite(maxChars) ||
    !Number.isInteger(maxChars) ||
    maxChars < 0 ||
    maxChars > MAX_FILE_HEAD_CHARS
  ) {
    throw new RangeError(
      `readFileHead: maxChars must be an integer in [0, ${MAX_FILE_HEAD_CHARS}], got ${maxChars}`,
    );
  }
  const handle = await open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(maxChars * MAX_BYTES_PER_UTF16_UNIT);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const decoded = new StringDecoder('utf8').write(buffer.subarray(0, bytesRead));
    return decoded.length > maxChars ? decoded.slice(0, maxChars) : decoded;
  } finally {
    await handle.close();
  }
}

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

const GLOB_REGEX_CACHE = new Map<string, RegExp>();

function getGlobRegex(pattern: string): RegExp {
  let re = GLOB_REGEX_CACHE.get(pattern);
  if (!re) {
    re = globToRegex(pattern);
    GLOB_REGEX_CACHE.set(pattern, re);
  }
  return re;
}

export function shouldExcludeDir(
  name: string,
  relativePath: string,
  excludePatterns: string[] = DEFAULT_EXCLUDE_PATTERNS,
  excludeHidden = false,
): boolean {
  if (excludeHidden && name.startsWith('.')) return true;

  const normalizedPath = relativePath.includes('\\')
    ? relativePath.replace(/\\/g, '/')
    : relativePath;
  return excludePatterns.some((rawPattern) => {
    const pattern = rawPattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (!pattern) return false;
    if (!pattern.includes('*') && !pattern.includes('?') && !pattern.includes('/')) {
      return name === pattern;
    }
    const matcher = getGlobRegex(pattern);
    return matcher.test(normalizedPath) || matcher.test(`${normalizedPath}/`);
  });
}

export async function gatherFiles(options: GatherFilesOptions): Promise<string[]> {
  const extensions = [
    ...new Set(
      options.extensions
        .filter((extension) => typeof extension === 'string' && extension.trim().length > 0)
        .map((extension) => {
          const lower = extension.toLowerCase().trim();
          return lower.startsWith('.') ? lower : `.${lower}`;
        }),
    ),
  ];
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
            extensions.some((extension) => {
              const lowerName = entry.name.toLowerCase();
              return (
                lowerName.endsWith(extension) ||
                (extension === '.env' && lowerName.startsWith('.env'))
              );
            }))
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
