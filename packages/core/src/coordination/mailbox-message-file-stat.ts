import * as fsp from 'node:fs/promises';
import type { MailboxMessageFileStat } from './mailbox-message-cache.js';

export async function statMailboxMessageFile(path: string): Promise<MailboxMessageFileStat> {
  try {
    const st = await fsp.stat(path);
    return { mtimeMs: st.mtimeMs, size: st.size };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { mtimeMs: -1, size: -1 };
    }
    throw err;
  }
}
