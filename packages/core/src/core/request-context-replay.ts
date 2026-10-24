import type { TextBlock } from '@wrongstack/contracts/types/blocks';
import { LIVE_CONTEXT_MARKER } from '@wrongstack/contracts/types/live-context';
import type { Message } from '@wrongstack/contracts/types/messages';
import type { Provider } from '@wrongstack/contracts/types/provider';

/** Request-only live state must retain its original position in an automatic-cache prefix. */
export class RequestContextReplay {
  private provider: Provider | undefined;
  private scope: string | undefined;
  private history: string[] = [];
  private context: string | undefined;
  private snapshots: { after: number; message: Message }[] = [];

  compose(
    history: readonly Message[],
    context: readonly TextBlock[],
    provider: Provider,
    scope: string,
  ): Message[] {
    const serialized = history.map((message) => JSON.stringify(message));
    // Compaction, repair, resume and session/account/model switches start a
    // new prefix. Never resurrect context from a discarded conversation.
    if (
      this.provider !== provider ||
      this.scope !== scope ||
      serialized.length < this.history.length ||
      this.history.some((message, index) => serialized[index] !== message)
    ) {
      this.snapshots = [];
      this.context = undefined;
    }
    this.provider = provider;
    this.scope = scope;
    this.history = serialized;

    const signature = JSON.stringify(context.map((block) => block.text));
    if (signature !== this.context && (context.length > 0 || this.snapshots.length > 0)) {
      this.snapshots.push({
        after: history.length,
        message: {
          role: 'user',
          content: [
            { type: 'text', text: LIVE_CONTEXT_MARKER },
            ...context.map((block): TextBlock => ({ type: 'text', text: block.text })),
          ],
        },
      });
    }
    this.context = signature;

    const messages: Message[] = [];
    let snapshotIndex = 0;
    for (let index = 0; index <= history.length; index++) {
      let snapshot = this.snapshots[snapshotIndex];
      while (snapshot?.after === index) {
        messages.push(snapshot.message);
        snapshotIndex++;
        snapshot = this.snapshots[snapshotIndex];
      }
      const message = history[index];
      if (message) messages.push(message);
    }
    return messages;
  }
}
