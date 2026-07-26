import { atomicWrite, withFileLock } from '../utils/atomic-write.js';
import { assertMailboxNotFenced } from './mailbox-version-fence.js';

interface MessageFileStat {
  mtimeMs: number;
  size: number;
}

interface ClearMailboxDeps {
  messagePath: string;
  statMessageFile(): Promise<MessageFileStat>;
  setMessageCache(messages: [], stat: MessageFileStat): void;
}

export async function runGlobalMailboxClearAll(deps: ClearMailboxDeps): Promise<void> {
  await withFileLock(deps.messagePath, async () => {
    // GM-P0.4A: Refuse mutation when a newer-version process has written
    // v2 receipt records to this mailbox.
    await assertMailboxNotFenced(deps.messagePath);
    await atomicWrite(deps.messagePath, '');
    deps.setMessageCache([], await deps.statMessageFile());
  });
}
