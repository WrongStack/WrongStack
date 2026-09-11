/**
 * clear-chat-context.ts — the ONE "wipe the current conversation" sequence.
 *
 * Three surfaces offer it (the `/clear` slash command, Ctrl+L, and the
 * desktop menu's `clear-context` action) and they used to spell it out
 * separately. Each of them dropped the coalescer, emptied the transcript and
 * told the server to clear its context — and each of them left the lane's
 * `isLoading` flag exactly where it was.
 *
 * That flag is not part of the transcript, so `clearMessages()` does not touch
 * it, but ChatView shows the welcome screen only when the lane is empty AND
 * idle. A clear issued while the flag was set therefore emptied the pane and
 * left it in the loading branch over zero rows: a blank box, with no way back
 * to the Bug Hunter / performance-ratchet launchers that live on the welcome
 * screen. The launchers themselves set the flag when they send their round, so
 * the screen the user wanted back was the one most likely to have armed it.
 *
 * The server's `session.start` answer to `context.clear` settles the flag too,
 * but only once it arrives, and only when the server actually answers — a flag
 * set locally by a launcher whose round never reached a run has nothing behind
 * it to answer at all.
 */
import { streamCoalescer } from './stream-coalescer.js';

interface ClearChatContextClient {
  clearContext?: (() => void) | undefined;
  sendAbort?: (() => void) | undefined;
}

interface ClearChatContextOptions {
  /** Socket to tell about the clear. */
  client: ClearChatContextClient | null | undefined;
  /** Does the lane believe a run is in flight? */
  isLoading: boolean;
  clearMessages: () => void;
  setLoading: (loading: boolean) => void;
  /** Abort override — the chat composer passes its own bound sender. */
  sendAbort?: (() => void) | undefined;
}

export function clearChatContext(options: ClearChatContextOptions): void {
  const { client, isLoading, clearMessages, setLoading, sendAbort } = options;
  streamCoalescer.dropAll();
  // A run that is still streaming has to be stopped, not orphaned: its deltas
  // would otherwise land in the transcript we are about to wipe.
  if (isLoading) (sendAbort ?? client?.sendAbort)?.();
  clearMessages();
  setLoading(false);
  client?.clearContext?.();
}
