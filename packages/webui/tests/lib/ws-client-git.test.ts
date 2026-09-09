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

  it('requests repository history and commit detail', () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    const send = vi.spyOn(client, 'send').mockImplementation(() => true);

    client.getGitHistory({ ref: 'refs/heads/main', limit: 80, skip: 20 });
    client.getGitCommitDetail('abc1234');
    client.getGitCommitFileDiff('abc1234', 'src/new.ts', 'src/old.ts');

    expect(send).toHaveBeenNthCalledWith(1, {
      type: 'git.history',
      payload: { ref: 'refs/heads/main', limit: 80, skip: 20 },
    });
    expect(send).toHaveBeenNthCalledWith(2, {
      type: 'git.commit_detail',
      payload: { hash: 'abc1234' },
    });
    expect(send).toHaveBeenNthCalledWith(3, {
      type: 'git.commit_file_diff',
      payload: { hash: 'abc1234', path: 'src/new.ts', previousPath: 'src/old.ts' },
    });
  });
});
