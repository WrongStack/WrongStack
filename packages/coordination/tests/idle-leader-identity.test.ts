import { EventBus } from '@wrongstack/contracts/kernel';
import { expect, it } from 'vitest';
import { AgentStatusTracker } from '../src/agent-status-tracker.js';

it('publishes an idle ACP leader identity before the first prompt and follows model changes', () => {
  const tracker = new AgentStatusTracker({
    events: new EventBus(),
    registry: { updateAgents: async () => {} } as never,
    sessionId: 'session-a',
  });
  tracker.syncLeaderIdentity({ provider: { id: 'acp' }, model: 'codex-cli' });
  expect(tracker.getAgents().find((x) => x.id === 'leader')).toMatchObject({
    provider: 'acp',
    model: 'codex-cli',
    status: 'idle',
  });
  tracker.syncLeaderIdentity({ provider: { id: 'openrouter' }, model: 'codex-cli' });
  expect(tracker.getAgents().find((x) => x.id === 'leader')).toMatchObject({
    provider: 'openrouter',
    model: 'codex-cli',
    status: 'idle',
  });
  tracker.stop();
});
