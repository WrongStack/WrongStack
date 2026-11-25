interface TranscriptEvent {
  type?: string;
  ts?: string;
  role?: string;
  content?: string | unknown;
  [k: string]: unknown;
}

const TRANSCRIPT_TAIL_READ_BYTES = 1024 * 1024;
const TRANSCRIPT_TAIL_CHUNK_BYTES = 64 * 1024;

export async function readTranscriptTail(
  transcriptPath: string | undefined,
  n: number,
): Promise<TranscriptEvent[]> {
  if (!transcriptPath || !Number.isFinite(n) || n <= 0) return [];
  const limit = Math.floor(n);
  if (limit <= 0) return [];
  let handle: import('node:fs/promises').FileHandle | undefined;
  try {
    const { open } = await import('node:fs/promises');
    handle = await open(transcriptPath, 'r');
    const size = (await handle.stat()).size;
    if (size === 0) return [];
    // Read backward in chunks until either the file is exhausted or we
    // have collected enough complete lines to satisfy the requested
    // count. We overshoot by one extra line so the chunk boundary never
    // falls inside the last event we are about to return — without that
    // margin, `slice(-n)` can drop the most recent event when the read
    // budget stops between two adjacent events. The first chunk may
    // contribute a partial head fragment when the budget saturates; we
    // drop that fragment before parsing so JSON.parse cannot choke on a
    // truncated event.
    let position = size;
    let retainedBytes = 0;
    let newlines = 0;
    const chunks: Buffer[] = [];
    while (position > 0 && retainedBytes < TRANSCRIPT_TAIL_READ_BYTES) {
      const length = Math.min(
        TRANSCRIPT_TAIL_CHUNK_BYTES,
        position,
        TRANSCRIPT_TAIL_READ_BYTES - retainedBytes,
      );
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) break;
      const chunk = bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      retainedBytes += bytesRead;
      // Count newlines in the chunk we just appended. We use `indexOf`
      // repeatedly so the cost stays linear in the chunk size; a per-byte
      // `for...of` loop would be O(n²) at the budget ceiling.
      let offset = chunk.indexOf(0x0a);
      while (offset !== -1) {
        newlines++;
        offset = chunk.indexOf(0x0a, offset + 1);
      }
      if (position === 0) break;
      // Keep reading until we have more than n newlines in the buffered
      // suffix. The +1 overshoot guarantees that even when the read
      // budget stops between two adjacent events, `slice(-n)` below will
      // land on event boundaries rather than byte boundaries.
      if (newlines > limit) break;
    }
    const joined = Buffer.concat(chunks).toString('utf8');
    // If the read loop bailed before reaching the file head, the very
    // first element after split('\n') is a partial event (no terminating
    // \n at its start). Drop it so JSON.parse does not throw on a
    // truncated JSON object — keeping only complete event lines.
    const truncatedHead = position > 0;
    const allLines = joined.split('\n');
    const candidateLines = truncatedHead ? allLines.slice(1) : allLines;
    const tail = candidateLines.filter((line) => line.length > 0).slice(-limit);
    const out: TranscriptEvent[] = [];
    for (const l of tail) {
      try {
        out.push(JSON.parse(l) as TranscriptEvent);
      } catch {
        // Skip malformed lines (e.g. mid-write corruption).
      }
    }
    return out;
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
