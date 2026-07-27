import { describe, expect, it, vi } from 'vitest';
import { WrongStackWebSocketClient } from '../../src/lib/ws-client';

describe('WrongStackWebSocketClient git requests', () => {
  it('sends git.changes request for the Changes panel', () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    const send = vi.spyOn(client, 'send').mockImplementation(() => true);

    client.getGitChanges();

    expect(send).toHaveBeenCalledWith({ type: 'git.changes' });
  });

  it('sends git.diff request with the selected repo-relative path', () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    const send = vi.spyOn(client, 'send').mockImplementation(() => true);

    client.getGitDiff('packages/webui/src/App.tsx');

    expect(send).toHaveBeenCalledWith({
      type: 'git.diff',
      payload: { path: 'packages/webui/src/App.tsx' },
    });
  });
});
