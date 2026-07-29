import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite, ulid } from '@wrongstack/core/utils';
import type { BrowserArtifact, BrowserArtifactKind } from './types.js';

/**
 * How long a browser artifact (screenshot, trace, download) stays on disk.
 *
 * Artifacts are debugging exhaust: a screenshot is interesting while the run
 * that produced it is being looked at, and dead weight after. Nothing pruned
 * them, so they accumulated for as long as the project existed — measured at
 * 2.1 GB across 247 files in one project. Seven days matches the tool-output
 * spool, which is the same kind of data with the same access pattern.
 */
const ARTIFACT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Roots already swept in this process. */
const sweptRoots = new Set<string>();

/** Reset module state — test hook (per-process sweep memo only). */
export function _resetArtifactSweepForTests(): void {
  sweptRoots.clear();
}

/**
 * Delete artifacts older than the retention window. Runs once per root per
 * process, detached and best-effort: a browser tool must never fail because
 * housekeeping could not read a directory.
 */
function sweepOldArtifacts(root: string): void {
  if (sweptRoots.has(root)) return;
  sweptRoots.add(root);
  void (async () => {
    const cutoff = Date.now() - ARTIFACT_RETENTION_MS;
    let sessionDirs: string[];
    try {
      const entries = await fs.readdir(root, { withFileTypes: true });
      sessionDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return; // no artifact root yet — nothing to sweep
    }
    for (const sessionDir of sessionDirs) {
      const dir = path.join(root, sessionDir);
      let names: string[];
      try {
        names = await fs.readdir(dir);
      } catch {
        continue;
      }
      let removed = 0;
      for (const name of names) {
        const target = path.join(dir, name);
        try {
          const stat = await fs.stat(target);
          if (stat.isFile() && stat.mtimeMs < cutoff) {
            await fs.rm(target, { force: true });
            removed++;
          }
        } catch {
          /* concurrently removed — ignore */
        }
      }
      // Drop the session directory once it has gone empty, so the artifact
      // root does not accumulate thousands of empty per-session folders.
      if (removed === names.length && names.length > 0) {
        await fs.rmdir(dir).catch(() => undefined);
      }
    }
  })();
}

export class BrowserArtifactStore {
  constructor(private readonly root: string) {
    sweepOldArtifacts(root);
  }

  async write(
    sessionId: string,
    kind: BrowserArtifactKind,
    extension: string,
    mimeType: string,
    content: Uint8Array,
  ): Promise<BrowserArtifact> {
    const id = ulid();
    const dir = path.join(this.root, safeSegment(sessionId));
    const target = path.join(dir, `${id}.${extension.replace(/^\./, '')}`);
    await atomicWrite(target, content, { mode: 0o600 });
    return this.record(id, sessionId, kind, target, mimeType);
  }

  private async record(
    id: string,
    sessionId: string,
    kind: BrowserArtifactKind,
    target: string,
    mimeType: string,
  ): Promise<BrowserArtifact> {
    await fs.chmod(target, 0o600).catch(() => undefined);
    const [stat, sha256] = await Promise.all([fs.stat(target), hashFile(target)]);
    const artifact: BrowserArtifact = {
      id,
      kind,
      sensitivity: 'sensitive',
      path: target,
      mimeType,
      sizeBytes: stat.size,
      sha256,
      createdAt: new Date().toISOString(),
    };
    const metadataPath = path.join(path.dirname(target), `${id}.metadata.json`);
    try {
      await atomicWrite(
        metadataPath,
        `${JSON.stringify({
          id: artifact.id,
          sessionId: safeSegment(sessionId),
          kind: artifact.kind,
          sensitivity: artifact.sensitivity,
          mimeType: artifact.mimeType,
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256,
          createdAt: artifact.createdAt,
        })}\n`,
        { mode: 0o600 },
      );
    } catch (error) {
      await fs.rm(target, { force: true }).catch(() => undefined);
      throw error;
    }
    return artifact;
  }

  pathFor(sessionId: string, extension: string): { id: string; path: string } {
    const id = ulid();
    return {
      id,
      path: path.join(this.root, safeSegment(sessionId), `${id}.${extension.replace(/^\./, '')}`),
    };
  }

  async describe(
    id: string,
    kind: BrowserArtifactKind,
    target: string,
    mimeType: string,
  ): Promise<BrowserArtifact> {
    return this.record(id, path.basename(path.dirname(target)), kind, target, mimeType);
  }
}

async function hashFile(target: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(target);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.once('error', reject);
    stream.once('end', resolve);
  });
  return hash.digest('hex');
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}
