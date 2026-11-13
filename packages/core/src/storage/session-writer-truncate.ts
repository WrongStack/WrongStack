import * as fsp from 'node:fs/promises';

const CHUNK_SIZE = 65_536;

export interface SessionTruncatePlan {
  checkpointByteOffset: number;
  removedCount: number;
  /** Transcript paths referenced ONLY by the removed window — safe to delete. */
  removedSubagentTranscriptPaths: string[];
  /**
   * Removed events that belong to a session-tree branch other than the one
   * being rewound, plus branch structure events. A byte-prefix cut cannot keep
   * them, so a non-zero count means the rewind would destroy other branches.
   */
  foreignBranchEventCount: number;
}

const BRANCH_STRUCTURE_EVENTS = new Set([
  'branch_created',
  'branch_switched',
  'branch_folded',
  'branch_status_changed',
]);

/** Owning branch of a journal line; the writer leaves `main`'s lines unstamped. */
function owningBranch(event: { branchId?: unknown }): string {
  return typeof event.branchId === 'string' && event.branchId ? event.branchId : 'main';
}

/**
 * Plan a rewind to `targetPromptIndex` on `branchId` (default `main`).
 *
 * A branched journal interleaves every branch and prompt indices restart per
 * lineage, so only the rewinding branch's own checkpoints are cut points —
 * the first matching checkpoint in the file may be another branch's.
 */
export async function findSessionCheckpointTruncatePlan(
  filePath: string,
  targetPromptIndex: number,
  branchId = 'main',
): Promise<SessionTruncatePlan | null> {
  let fd: fsp.FileHandle | undefined;
  let fileOffset = 0;
  let pendingLine = Buffer.alloc(0);
  let checkpointByteOffset = -1;
  let removedCount = 0;
  let foreignBranchEventCount = 0;
  const removedSubagentTranscriptPaths = new Set<string>();
  const retainedSubagentTranscriptPaths = new Set<string>();

  try {
    fd = await fsp.open(filePath, 'r', 0o600);

    while (true) {
      const buf = Buffer.alloc(CHUNK_SIZE);
      const { bytesRead } = await fd.read(buf, 0, CHUNK_SIZE, fileOffset);
      if (bytesRead === 0) break;

      const carriedBytes = pendingLine.length;
      const chunk =
        carriedBytes === 0
          ? buf.subarray(0, bytesRead)
          : Buffer.concat([pendingLine, buf.subarray(0, bytesRead)]);
      const chunkFileOffset = fileOffset - carriedBytes;
      let chunkPos = 0;
      while (chunkPos < chunk.length) {
        const idx = chunk.indexOf('\n', chunkPos);
        if (idx === -1) break;

        const lineStartOffset = chunkFileOffset + chunkPos;
        const lineBytes = chunk.subarray(chunkPos, idx);
        if (checkpointByteOffset !== -1) {
          removedCount++;
          if (isForeignBranchLine(lineBytes, branchId)) foreignBranchEventCount++;
          collectSubagentTranscriptPath(lineBytes, removedSubagentTranscriptPaths);
        } else {
          // eslint-disable-next-line no-sync
          const line = new TextDecoder('utf-8', { fatal: false }).decode(lineBytes);
          if (line.trim()) {
            try {
              const event = JSON.parse(line) as {
                type?: string;
                promptIndex?: number;
                transcriptPath?: unknown;
                branchId?: unknown;
              };
              if (event.type === 'agent_session_linked') {
                // Retained history may still reference a transcript that a
                // later (removed) re-link also mentions — the file must
                // survive while any surviving event points at it.
                if (typeof event.transcriptPath === 'string' && event.transcriptPath.trim()) {
                  retainedSubagentTranscriptPaths.add(event.transcriptPath);
                }
              } else if (event.type === 'checkpoint' && owningBranch(event) === branchId) {
                if (event.promptIndex === targetPromptIndex) {
                  checkpointByteOffset = lineStartOffset;
                } else if (
                  event.promptIndex !== undefined &&
                  event.promptIndex > targetPromptIndex
                ) {
                  checkpointByteOffset = lineStartOffset;
                }
              }
            } catch {
              // Malformed JSON is preserved by the rewrite step.
            }
          }
        }

        chunkPos = idx + 1;
      }

      pendingLine = chunk.subarray(chunkPos);
      fileOffset += bytesRead;
    }
  } finally {
    await fd?.close();
  }

  if (checkpointByteOffset === -1) return null;
  return {
    checkpointByteOffset,
    removedCount,
    foreignBranchEventCount,
    removedSubagentTranscriptPaths: [...removedSubagentTranscriptPaths]
      .filter((transcriptPath) => !retainedSubagentTranscriptPaths.has(transcriptPath))
      .sort(),
  };
}

function isForeignBranchLine(lineBytes: Buffer, branchId: string): boolean {
  // eslint-disable-next-line no-sync
  const line = new TextDecoder('utf-8', { fatal: false }).decode(lineBytes);
  if (!line.trim()) return false;
  try {
    const event = JSON.parse(line) as { type?: unknown; branchId?: unknown };
    if (typeof event.type === 'string' && BRANCH_STRUCTURE_EVENTS.has(event.type)) return true;
    return owningBranch(event) !== branchId;
  } catch {
    return false;
  }
}

function collectSubagentTranscriptPath(lineBytes: Buffer, out: Set<string>): void {
  // eslint-disable-next-line no-sync
  const line = new TextDecoder('utf-8', { fatal: false }).decode(lineBytes);
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line) as {
      type?: string;
      transcriptPath?: unknown;
    };
    if (event.type !== 'agent_session_linked') return;
    if (typeof event.transcriptPath === 'string' && event.transcriptPath.trim()) {
      out.add(event.transcriptPath);
    }
  } catch {
    // Malformed JSON is preserved/ignored consistently with checkpoint scan.
  }
}

export async function rewriteSessionToCheckpoint(
  filePath: string,
  checkpointByteOffset: number,
): Promise<void> {
  const tmpPath = `${filePath}.rewind.tmp`;
  const src = await fsp.open(filePath, 'r', 0o600);
  let srcClosed = false;

  const closeSrc = async (): Promise<void> => {
    if (srcClosed) return;
    srcClosed = true;
    await src.close();
  };

  try {
    const statResult = await src.stat();
    const totalSize = statResult.size;
    const prefixBytes = checkpointByteOffset;
    let newlineAfterCheckpoint = prefixBytes;

    if (prefixBytes < totalSize) {
      const probeBuf = Buffer.alloc(Math.min(CHUNK_SIZE, totalSize - prefixBytes));
      const { bytesRead: probeRead } = await src.read(probeBuf, 0, probeBuf.length, prefixBytes);
      if (probeRead > 0) {
        const nl = probeBuf.indexOf('\n');
        newlineAfterCheckpoint = nl !== -1 ? prefixBytes + nl + 1 : totalSize;
      }
    } else {
      newlineAfterCheckpoint = totalSize;
    }

    const writeFd = await fsp.open(tmpPath, 'w', 0o600);
    try {
      let readOffset = 0;
      while (readOffset < newlineAfterCheckpoint) {
        const toCopy = Math.min(CHUNK_SIZE, newlineAfterCheckpoint - readOffset);
        const copyBuf = Buffer.alloc(toCopy);
        const { bytesRead: r } = await src.read(copyBuf, 0, toCopy, readOffset);
        if (r === 0) break;
        await writeFd.write(copyBuf, 0, r);
        readOffset += r;
      }

      await writeFd.sync();
    } finally {
      await writeFd.close();
    }

    await closeSrc();
    await fsp.rename(tmpPath, filePath);
  } catch (err) {
    await closeSrc().catch(() => undefined);
    await fsp.unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}
