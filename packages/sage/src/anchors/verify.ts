import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { assertProjectAgentRole, FLEET_ROSTER } from '@wrongstack/core/coordination';
import type {
  AnchorVerificationResult,
  MemoryAnchor,
  MemoryVerificationResult,
  Sage,
  VerificationStatus,
} from '../types.js';

const execFileAsync = promisify(execFile);

export async function verifyMemoryAnchors(
  projectRoot: string,
  memory: Sage,
  checkedAt = new Date().toISOString(),
  signal?: AbortSignal,
): Promise<MemoryVerificationResult> {
  signal?.throwIfAborted();
  const anchors = await Promise.all(
    memory.anchors.map((anchor) => verifyAnchor(projectRoot, anchor, signal)),
  );
  return {
    memoryId: memory.id,
    status: aggregateStatus(anchors),
    checkedAt,
    anchors,
  };
}

async function verifyAnchor(
  projectRoot: string,
  anchor: MemoryAnchor,
  signal?: AbortSignal,
): Promise<AnchorVerificationResult> {
  signal?.throwIfAborted();
  if (anchor.type === 'command') {
    return { anchor, status: 'unknown', reason: 'Command anchors require execution evidence.' };
  }
  if (anchor.type === 'agent') {
    let role: string;
    try {
      role = assertProjectAgentRole(anchor.role ?? '').toLowerCase();
    } catch {
      return { anchor, status: 'stale', reason: 'Agent anchor has an invalid role.' };
    }
    const customRolePath = path.join(projectRoot, '.wrongstack', 'agents', role);
    const customRoleExists = await fs
      .stat(customRolePath)
      .then((stat) => stat.isDirectory())
      .catch(() => false);
    return FLEET_ROSTER[role] || customRoleExists
      ? { anchor, status: 'verified', reason: `Agent role "${role}" is available.` }
      : { anchor, status: 'stale', reason: `Agent role "${role}" is not in the roster.` };
  }
  if (!anchor.path) {
    return { anchor, status: 'unknown', reason: 'Anchor has no path.' };
  }

  const absolutePath = path.resolve(projectRoot, anchor.path);
  if (!isInside(projectRoot, absolutePath)) {
    return { anchor, status: 'stale', reason: 'Anchor resolves outside the project root.' };
  }

  let stat;
  let realPath: string;
  try {
    stat = await fs.stat(absolutePath);
    realPath = await fs.realpath(absolutePath);
  } catch {
    return { anchor, status: 'stale', reason: 'Anchored path no longer exists.' };
  }

  const realRoot = await resolveRealRoot(projectRoot);
  if (!isInside(realRoot, realPath)) {
    return {
      anchor,
      status: 'stale',
      reason: 'Anchor resolves through a symlink outside the project root.',
    };
  }

  if (anchor.type === 'directory' || anchor.type === 'package') {
    return stat.isDirectory()
      ? {
          anchor,
          status: 'verified',
          reason: anchor.type === 'package' ? 'Package directory exists.' : 'Directory exists.',
        }
      : {
          anchor,
          status: 'stale',
          reason: `${anchor.type === 'package' ? 'Package' : 'Directory'} anchor points to a non-directory.`,
        };
  }
  if (!stat.isFile()) {
    return { anchor, status: 'stale', reason: 'File anchor points to a non-file.' };
  }

  const body = await fs.readFile(realPath, signal ? { signal } : undefined);
  const contentHash = `sha256:${createHash('sha256').update(body).digest('hex')}`;
  if (anchor.contentHash && anchor.contentHash !== contentHash) {
    return { anchor, status: 'stale', reason: 'File content hash changed.', contentHash };
  }

  if (anchor.symbol) {
    const text = body.toString('utf8');
    if (!containsSymbol(text, anchor.symbol)) {
      return {
        anchor,
        status: 'stale',
        reason: `Symbol "${anchor.symbol}" no longer exists.`,
        contentHash,
      };
    }
  }

  let gitBlobHash: string | undefined;
  if (anchor.gitBlobHash || anchor.type === 'git') {
    try {
      const result = await execFileAsync('git', ['hash-object', realPath], {
        cwd: projectRoot,
        windowsHide: true,
        timeout: 5_000,
        signal,
      });
      gitBlobHash = result.stdout.trim();
      if (anchor.gitBlobHash && anchor.gitBlobHash !== gitBlobHash) {
        return {
          anchor,
          status: 'stale',
          reason: 'Git blob hash changed.',
          contentHash,
          gitBlobHash,
        };
      }
    } catch {
      return {
        anchor,
        status: 'unknown',
        reason: 'Git blob could not be calculated.',
        contentHash,
      };
    }
  }

  return { anchor, status: 'verified', reason: 'Anchor is current.', contentHash, gitBlobHash };
}

function containsSymbol(text: string, symbol: string): boolean {
  const escaped = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

function aggregateStatus(results: AnchorVerificationResult[]): VerificationStatus {
  if (results.length === 0) return 'unknown';
  if (results.some((result) => result.status === 'contradicted')) return 'contradicted';
  if (results.some((result) => result.status === 'stale')) return 'stale';
  if (results.every((result) => result.status === 'verified')) return 'verified';
  return 'unknown';
}

function isInside(root: string, target: string): boolean {
  const relative = path.relative(path.resolve(root), target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveRealRoot(projectRoot: string): Promise<string> {
  return fs.realpath(projectRoot).catch(() => path.resolve(projectRoot));
}

/** Direct-module test seam; intentionally not re-exported by the package barrel. */
export const anchorVerificationCoverage = {
  verifyAnchor,
  containsSymbol,
  aggregateStatus,
  isInside,
  resolveRealRoot,
};
