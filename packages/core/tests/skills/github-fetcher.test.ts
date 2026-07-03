import * as fs from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  downloadGitHubTarball,
  parseSkillRef,
  resolveGitHubToken,
} from '../../src/skills/github-fetcher.js';

// ── parseSkillRef ────────────────────────────────────────────────────────────

describe('parseSkillRef', () => {
  it('parses bare user/repo as ref=main', () => {
    expect(parseSkillRef('user/repo')).toEqual({ owner: 'user', repo: 'repo', ref: 'main' });
  });

  it('parses user/repo@ref', () => {
    expect(parseSkillRef('user/repo@v1.2.3')).toEqual({
      owner: 'user',
      repo: 'repo',
      ref: 'v1.2.3',
    });
  });

  it('strips https://github.com/ prefix', () => {
    expect(parseSkillRef('https://github.com/user/repo')).toEqual({
      owner: 'user',
      repo: 'repo',
      ref: 'main',
    });
  });

  it('strips http:// prefix and .git suffix', () => {
    expect(parseSkillRef('http://github.com/user/repo.git')).toEqual({
      owner: 'user',
      repo: 'repo',
      ref: 'main',
    });
  });

  it('handles whitespace', () => {
    expect(parseSkillRef('  user/repo@v1  ')).toEqual({
      owner: 'user',
      repo: 'repo',
      ref: 'v1',
    });
  });

  it('throws on too-few slash-separated parts', () => {
    expect(() => parseSkillRef('justarepo')).toThrow(/Invalid skill reference/);
  });

  it('throws on empty string', () => {
    expect(() => parseSkillRef('')).toThrow(/Invalid/);
  });

  it('handles SHA-style refs', () => {
    const ref = 'a1b2c3d4e5f6';
    expect(parseSkillRef(`u/r@${ref}`)).toEqual({ owner: 'u', repo: 'r', ref });
  });
});

// ── downloadGitHubTarball ────────────────────────────────────────────────────

const origFetch = globalThis.fetch;

function makeTarball(files: Array<{ name: string; content: string }>): Buffer {
  // Build a minimal POSIX ustar archive with a fake top-level dir.
  const TOP = 'owner-repo-deadbeef/';
  const blocks: Buffer[] = [];

  for (const f of files) {
    const path = TOP + f.name;
    const contentBuf = Buffer.from(f.content, 'utf8');
    const header = Buffer.alloc(512);
    Buffer.from(path).copy(header, 0);
    // file size (12 bytes octal, NUL-terminated)
    const sizeOct = contentBuf.length.toString(8).padStart(11, '0') + '\0';
    Buffer.from(sizeOct).copy(header, 124);
    // typeflag '0' (regular file)
    header[156] = 0x30;
    blocks.push(header);
    // padded data
    const padded = Buffer.alloc(Math.ceil(contentBuf.length / 512) * 512);
    contentBuf.copy(padded);
    blocks.push(padded);
  }

  // End-of-archive: two zero blocks
  blocks.push(Buffer.alloc(512));
  blocks.push(Buffer.alloc(512));

  return Buffer.concat(blocks);
}

function mockFetchOk(tarball: Buffer, contentLength?: string) {
  const gz = gzipSync(tarball);
  const headers = new Headers({ 'content-type': 'application/gzip' });
  if (contentLength !== undefined) headers.set('content-length', contentLength);
  return Promise.resolve(
    new Response(new Uint8Array(gz), {
      status: 200,
      headers,
    }),
  );
}

afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

describe('downloadGitHubTarball', () => {
  it('downloads, extracts files, returns tempDir path', async () => {
    globalThis.fetch = vi.fn().mockReturnValue(
      mockFetchOk(
        makeTarball([
          { name: 'SKILL.md', content: '# Skill\n' },
          { name: 'docs/intro.md', content: 'intro' },
        ]),
      ),
    ) as never;

    const { tempDir } = await downloadGitHubTarball({ owner: 'u', repo: 'r', ref: 'main' });
    try {
      const skill = await fs.readFile(`${tempDir}/SKILL.md`, 'utf8');
      expect(skill).toBe('# Skill\n');
      const intro = await fs.readFile(`${tempDir}/docs/intro.md`, 'utf8');
      expect(intro).toBe('intro');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('throws repo-not-found on 404', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 404, statusText: 'Not Found' })) as never;
    await expect(downloadGitHubTarball({ owner: 'u', repo: 'r', ref: 'main' })).rejects.toThrow(
      /Repository not found/,
    );
  });

  it('mentions non-default ref in 404 error', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 404, statusText: 'Not Found' })) as never;
    await expect(downloadGitHubTarball({ owner: 'u', repo: 'r', ref: 'v1.2.3' })).rejects.toThrow(
      /v1\.2\.3/,
    );
  });

  it('throws access-denied on 403', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 403, statusText: 'Forbidden' })) as never;
    await expect(downloadGitHubTarball({ owner: 'u', repo: 'r', ref: 'main' })).rejects.toThrow(
      /Access denied/,
    );
  });

  it('throws generic error on other failure status', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 500, statusText: 'Server Error' })) as never;
    await expect(downloadGitHubTarball({ owner: 'u', repo: 'r', ref: 'main' })).rejects.toThrow(
      /GitHub API error \(500\)/,
    );
  });

  it('rejects tarballs larger than MAX_TARBALL_SIZE via content-length header', async () => {
    const huge = (60 * 1024 * 1024).toString(); // 60MB
    globalThis.fetch = vi.fn().mockReturnValue(mockFetchOk(makeTarball([]), huge)) as never;
    await expect(downloadGitHubTarball({ owner: 'u', repo: 'r', ref: 'main' })).rejects.toThrow(
      /too large/,
    );
  });

  it('rejects empty response body', async () => {
    // null-body response by going through the cast
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 200, headers: { 'content-type': 'application/gzip' } }),
      ) as never;
    await expect(downloadGitHubTarball({ owner: 'u', repo: 'r', ref: 'main' })).rejects.toThrow(
      /Empty response body/,
    );
  });

  it('sends an Authorization header when GITHUB_TOKEN is set', async () => {
    const prev = process.env['GITHUB_TOKEN'];
    process.env['GITHUB_TOKEN'] = 'ghp_testtoken';
    const seenHeaders: Record<string, string> = {};
    try {
      globalThis.fetch = vi.fn().mockImplementation((_url, init) => {
        Object.assign(seenHeaders, (init as RequestInit).headers as Record<string, string>);
        return mockFetchOk(makeTarball([{ name: 'SKILL.md', content: 'x' }]));
      }) as never;
      const { tempDir } = await downloadGitHubTarball({ owner: 'u', repo: 'r', ref: 'main' });
      await fs.rm(tempDir, { recursive: true, force: true });
      expect(seenHeaders['Authorization']).toBe('Bearer ghp_testtoken');
    } finally {
      if (prev === undefined) delete process.env['GITHUB_TOKEN'];
      else process.env['GITHUB_TOKEN'] = prev;
    }
  });

  it('mentions GITHUB_TOKEN in the rate-limit 403 message', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('', {
        status: 403,
        statusText: 'Forbidden',
        headers: { 'x-ratelimit-remaining': '0' },
      }),
    ) as never;
    await expect(downloadGitHubTarball({ owner: 'u', repo: 'r', ref: 'main' })).rejects.toThrow(
      /rate limit/i,
    );
  });

  it('mentions GITHUB_TOKEN in the 404 message (private repo hint)', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('', { status: 404, statusText: 'Not Found' })) as never;
    await expect(
      downloadGitHubTarball({ owner: 'u', repo: 'private', ref: 'main' }),
    ).rejects.toThrow(/GITHUB_TOKEN/);
  });

  it('wraps network errors as FetchError (status 0)', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ETIMEDOUT')) as never;
    await expect(downloadGitHubTarball({ owner: 'u', repo: 'r', ref: 'main' })).rejects.toThrow(
      /Network error/,
    );
  });
});

// ── resolveGitHubToken ───────────────────────────────────────────────────

describe('resolveGitHubToken', () => {
  it('returns undefined when no token env var is set', () => {
    expect(resolveGitHubToken({})).toBeUndefined();
  });

  it('prefers WRONGSTACK_GITHUB_TOKEN', () => {
    expect(
      resolveGitHubToken({
        WRONGSTACK_GITHUB_TOKEN: 'ws-token',
        GITHUB_TOKEN: 'gh-token',
        GH_TOKEN: 'gh-cli',
      }),
    ).toBe('ws-token');
  });

  it('falls back to GITHUB_TOKEN', () => {
    expect(resolveGitHubToken({ GITHUB_TOKEN: 'gh-token', GH_TOKEN: 'gh-cli' })).toBe('gh-token');
  });

  it('falls back to GH_TOKEN (gh CLI convention)', () => {
    expect(resolveGitHubToken({ GH_TOKEN: 'gh-cli' })).toBe('gh-cli');
  });

  it('treats a whitespace-only token as unset', () => {
    expect(resolveGitHubToken({ GITHUB_TOKEN: '   ' })).toBeUndefined();
  });
});
