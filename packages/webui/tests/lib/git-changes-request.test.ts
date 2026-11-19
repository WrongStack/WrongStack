import { describe, expect, it } from 'vitest';
import { handleGitChanges } from '@/hooks/ws-handlers/misc-handlers';
import { WrongStackWebSocketClient } from '@/lib/ws-client';
import { useGitChangesStore } from '@/stores/git-changes-store';

// The server echoes a request's requestId on git.* replies (correlatedReply), and
// requests are answered concurrently, so an older snapshot can arrive last.
function requests(count: number): string[] {
  const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
  const ids: string[] = [];
  client.send = ((message: { payload?: { requestId?: string } }) => {
    ids.push(message.payload?.requestId ?? '');
    return true;
  }) as never;
  for (let i = 0; i < count; i++) client.getGitChanges();
  return ids;
}
const answer = (files: string[], requestId?: string) =>
  handleGitChanges({
    type: 'git.changes',
    payload: {
      files: files.map((path) => ({ path, status: 'M', added: 1, deleted: 0, staged: false })),
      ...(requestId ? { requestId } : {}),
    },
  } as never);
const shown = () => useGitChangesStore.getState().files.map((f) => f.path);

describe('git.changes replies', () => {
  it('drop an older snapshot answered after the newest one', () => {
    const [older, newer] = requests(2);
    answer(['a.ts', 'edited.ts'], newer);
    answer(['a.ts'], older);
    expect(shown()).toEqual(['a.ts', 'edited.ts']);
  });

  it('apply a reply that names no request', () => {
    requests(1);
    answer(['pushed.ts']);
    expect(shown()).toEqual(['pushed.ts']);
  });
});
