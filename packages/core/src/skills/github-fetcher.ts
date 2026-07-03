import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { ERROR_CODES, FetchError, WrongStackError } from '../types/errors.js';
import { expectDefined } from '../utils/expect-defined.js';
import { SKILL_LIMITS } from './limits.js';

export interface ParsedRef {
  owner: string;
  repo: string;
  ref: string;
}

/**
 * Parse a skill reference string.
 * Formats: `user/repo` (default ref: main), `user/repo@ref`
 */
export function parseSkillRef(input: string): ParsedRef {
  const trimmed = input
    .trim()
    .replace(/^https?:\/\/github\.com\//, '')
    .replace(/\.git$/, '');
  const atIdx = trimmed.indexOf('@');
  let refPath: string;
  let ref: string;
  if (atIdx > 0) {
    refPath = trimmed.slice(0, atIdx);
    ref = trimmed.slice(atIdx + 1);
  } else {
    refPath = trimmed;
    ref = 'main';
  }
  const parts = refPath.split('/').filter(Boolean);
  if (parts.length < 2) {
    throw new WrongStackError({
      message: `Invalid skill reference "${input}". Expected format: user/repo or user/repo@ref`,
      code: ERROR_CODES.UNKNOWN,
      subsystem: 'general',
      context: { input },
    });
  }
  return { owner: expectDefined(parts[0]), repo: expectDefined(parts[1]), ref };
}

export interface DownloadResult {
  /** Temp directory containing the extracted repo. Caller must clean up. */
  tempDir: string;
}

/**
 * Resolve a GitHub auth token, if one is configured.
 *
 * Order: `WRONGSTACK_GITHUB_TOKEN` (WrongStack-specific override) → `GITHUB_TOKEN`
 * → `GH_TOKEN` (the gh CLI convention). Returns `undefined` when none are set,
 * which means only public repos can be fetched.
 *
 * Exposed for testing and for the installer's user-facing messaging (so it can
 * say "set GITHUB_TOKEN to install private repos" rather than just "403").
 */
export function resolveGitHubToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env['WRONGSTACK_GITHUB_TOKEN'] ?? env['GITHUB_TOKEN'] ?? env['GH_TOKEN'];
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Download and extract a GitHub repository tarball.
 *
 * Auth: reads `WRONGSTACK_GITHUB_TOKEN` / `GITHUB_TOKEN` / `GH_TOKEN` (in that
 * order). Without a token only public repos work; with one, private repos the
 * token can read also work, and the API rate limit is the authenticated
 * (much higher) limit instead of the anonymous 60/hour.
 *
 * Returns the path to a temp directory with the extracted contents. The caller
 * must remove it (the installer does this in a `finally`).
 */
export async function downloadGitHubTarball(parsed: ParsedRef): Promise<DownloadResult> {
  const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/tarball/${parsed.ref}`;
  const token = resolveGitHubToken();

  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'wrongstack-skill-installer',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(url, {
      signal: AbortSignal.timeout(30_000),
      headers,
      redirect: 'follow',
    });
  } catch (err) {
    // Network error / timeout — surface as a recoverable FetchError so callers
    // can retry if they want. Don't leak the raw error (may contain the URL).
    throw new FetchError({
      message: `Network error fetching ${parsed.owner}/${parsed.repo}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      status: 0,
      context: { owner: parsed.owner, repo: parsed.repo, ref: parsed.ref, op: 'tarball' },
      cause: err,
    });
  }

  if (!response.ok) {
    if (response.status === 404) {
      throw new WrongStackError({
        message:
          `Repository not found: ${parsed.owner}/${parsed.repo}` +
          (parsed.ref !== 'main' ? ` (ref: ${parsed.ref})` : '') +
          (token ? '' : '. If this is a private repo, set GITHUB_TOKEN (or GH_TOKEN).'),
        code: ERROR_CODES.UNKNOWN,
        subsystem: 'general',
        context: { owner: parsed.owner, repo: parsed.repo, ref: parsed.ref, status: 404 },
      });
    }
    if (response.status === 403) {
      // Distinguish rate-limit (anonymous 60/hour) from a real access denial.
      const remaining = response.headers.get('x-ratelimit-remaining');
      const isRateLimited = remaining === '0';
      throw new WrongStackError({
        message: isRateLimited
          ? `GitHub API rate limit exceeded. Set GITHUB_TOKEN (or GH_TOKEN) to use the higher authenticated limit.`
          : `Access denied: ${parsed.owner}/${parsed.repo}. The repository may be private (set GITHUB_TOKEN to install private repos) or rate-limited.`,
        code: ERROR_CODES.UNKNOWN,
        subsystem: 'general',
        context: {
          owner: parsed.owner,
          repo: parsed.repo,
          status: 403,
          rateLimited: isRateLimited,
          hasToken: Boolean(token),
        },
      });
    }
    throw new WrongStackError({
      message: `GitHub API error (${response.status}): ${response.statusText}`,
      code: ERROR_CODES.UNKNOWN,
      subsystem: 'general',
      context: { owner: parsed.owner, repo: parsed.repo, status: response.status },
    });
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength && Number.parseInt(contentLength, 10) > SKILL_LIMITS.MAX_TARBALL_SIZE) {
    throw new WrongStackError({
      message:
        `Tarball too large (${(Number.parseInt(contentLength, 10) / 1024 / 1024).toFixed(1)}MB). ` +
        `Max: ${SKILL_LIMITS.MAX_TARBALL_SIZE / 1024 / 1024}MB`,
      code: ERROR_CODES.UNKNOWN,
      subsystem: 'general',
      context: {
        owner: parsed.owner,
        repo: parsed.repo,
        contentLengthBytes: Number.parseInt(contentLength, 10),
        maxBytes: SKILL_LIMITS.MAX_TARBALL_SIZE,
      },
    });
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'wskill-'));

  try {
    if (!response.body) {
      throw new WrongStackError({
        message: 'Empty response body from GitHub API',
        code: ERROR_CODES.UNKNOWN,
        subsystem: 'general',
        context: { owner: parsed.owner, repo: parsed.repo },
      });
    }

    // Gunzip the response body, then extract the tar stream
    const nodeStream = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream);
    const gunzip = createGunzip();

    // Collect the uncompressed tar data into a buffer, then extract
    const chunks: Buffer[] = [];
    await pipeline(nodeStream, gunzip, async (source) => {
      for await (const chunk of source) {
        chunks.push(Buffer.from(chunk));
      }
    });
    const tarBuf = Buffer.concat(chunks);

    // Extract tar archive (POSIX ustar format)
    await extractTar(tarBuf, tempDir);

    return { tempDir };
  } catch (err) {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Minimal POSIX tar extractor. Handles the ustar format produced by GitHub.
 * Only extracts regular files and directories — symlinks and special entries
 * are skipped for security.
 */
async function extractTar(buf: Buffer, destDir: string): Promise<void> {
  let offset = 0;

  while (offset + 512 <= buf.length) {
    // Check for end-of-archive (two consecutive zero blocks)
    const header = buf.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;

    // Parse ustar header
    const name = readTarString(buf, offset, 100); // name field
    const prefix = readTarString(buf, offset + 345, 155); // ustar prefix
    const size = Number.parseInt(readTarString(buf, offset + 124, 12).trim(), 8) || 0;
    const typeflag = buf[offset + 156] ?? 0;

    // Full path: prefix/name (ustar) or just name
    const fullPath = prefix ? `${prefix}/${name}` : name;
    // Strip the top-level directory (GitHub tarballs have owner-repo-sha/)
    const relPath = stripTopDir(fullPath);

    if (relPath && relPath !== '.' && relPath !== '..') {
      const destPath = path.join(destDir, relPath);

      // Zip-slip guard: reject any entry whose resolved path escapes destDir
      // (e.g. a crafted entry name like `x/../../../etc/cron.d/evil`). GitHub
      // tarballs are built from git trees and so cannot carry `..` components,
      // but this extractor is generic — never trust archive entry names.
      const resolvedDest = path.resolve(destPath);
      const resolvedRoot = path.resolve(destDir);
      if (resolvedDest !== resolvedRoot && !resolvedDest.startsWith(resolvedRoot + path.sep)) {
        // Skip the entry entirely; advance past its data below.
        offset += 512 + Math.ceil(size / 512) * 512;
        continue;
      }

      // typeflag: '0' or '\0' = regular file, '5' = directory
      if (typeflag === 0x35 || typeflag === 0) {
        // Directory
        if (relPath.endsWith('/') || typeflag === 0x35) {
          await fs.mkdir(destPath, { recursive: true });
        }
      }

      if ((typeflag === 0x30 || typeflag === 0 || typeflag === 0x00) && size > 0) {
        // Regular file
        const dir = path.dirname(destPath);
        await fs.mkdir(dir, { recursive: true });
        const dataStart = offset + 512;
        const dataEnd = dataStart + size;
        if (dataEnd > buf.length) break; // truncated archive
        await fs.writeFile(destPath, buf.subarray(dataStart, dataEnd));
      }
    }

    // Advance: 512-byte header + data padded to 512-byte boundary
    offset += 512 + Math.ceil(size / 512) * 512;
  }
}

function readTarString(buf: Buffer, start: number, maxLen: number): string {
  let end = start;
  while (end < start + maxLen && end < buf.length && buf[end] !== 0) {
    end++;
  }
  return buf.subarray(start, end).toString('utf8');
}

/**
 * Strip the top-level directory from a tar path.
 * GitHub tarballs have a single root dir like `owner-repo-sha/`.
 */
function stripTopDir(p: string): string {
  const idx = p.indexOf('/');
  if (idx === -1) return ''; // top-level file, skip
  return p.slice(idx + 1);
}
