import type { SessionWriter } from '@wrongstack/core/types';

export function createParentSubagentSessionWriter(parentSession: SessionWriter): SessionWriter {
  return {
    id: parentSession.id,
    transcriptPath: parentSession.transcriptPath,
    get pendingToolUses(): string[] {
      return [];
    },
    append: (event) => parentSession.append({ ...event }),
    appendBatch: (events) => parentSession.appendBatch(events.map((event) => ({ ...event }))),
    flush: () => parentSession.flush(),
    close: async () => {},
    recordFileChange: () => {},
    recordSideEffect: () => {},
    writeCheckpoint: async () => {},
    writeFileSnapshot: async () => {},
    truncateToCheckpoint: async () => 0,
    clearSession: async () => {},
    writeInFlightMarker: async () => {},
    clearInFlightMarker: async () => {},
  };
}
