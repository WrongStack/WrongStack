import { describe, expect, it } from 'vitest';
import type { AgentEntry, ChatEntry } from '../src/lib/session';
import {
  agentsNeedAttention,
  autoSubmitAllowed,
  canStopWork,
  latestAssistantId,
  liveAgents,
  workspaceLocked,
} from '../src/lib/workspace-derived';

const agent = (status: string, work: Partial<AgentEntry> = {}): AgentEntry => ({
  id: `agent-${status}`,
  name: status,
  sequence: 0,
  status,
  task: '',
  provider: '',
  model: '',
  currentTool: '',
  partialText: '',
  iterations: 0,
  toolCalls: 0,
  costUsd: 0,
  tokens: 0,
  maxContext: 0,
  entries: [],
  ...work,
});

const ACTIVE = ['running', 'busy', 'working', 'active', 'starting', 'spawned'];
const INACTIVE = ['idle', 'completed', 'done', 'failed', 'stopped', 'queued', ''];

describe('liveAgents', () => {
  it('keeps exactly the active statuses, in order', () => {
    const agents = [...INACTIVE, ...ACTIVE].map((status) => agent(status));
    expect(liveAgents(agents).map((item) => item.status)).toEqual(ACTIVE);
  });
});

describe('workspaceLocked', () => {
  const idle = {
    ready: true,
    connection: 'open',
    running: false,
    agents: [agent('completed')],
    modelPending: false,
    compactPending: false,
  };

  it('is unlocked only for a ready, open, idle workspace', () => {
    expect(workspaceLocked(idle)).toBe(false);
  });

  it.each([
    ['not ready', { ready: false }],
    ['connecting', { connection: 'connecting' }],
    ['closed', { connection: 'closed' }],
    ['leader running', { running: true }],
    ['model switch pending', { modelPending: true }],
    ['compaction pending', { compactPending: true }],
  ])('locks while %s', (_, change) => {
    expect(workspaceLocked({ ...idle, ...change })).toBe(true);
  });

  it.each(ACTIVE)('locks while a worker is %s', (status) => {
    expect(workspaceLocked({ ...idle, agents: [agent('completed'), agent(status)] })).toBe(true);
  });
});

describe('canStopWork', () => {
  it('requires live work on a ready, open connection', () => {
    const base = { hasActiveWork: true, ready: true, connection: 'open' };
    expect(canStopWork(base)).toBe(true);
    expect(canStopWork({ ...base, hasActiveWork: false })).toBe(false);
    expect(canStopWork({ ...base, ready: false })).toBe(false);
    expect(canStopWork({ ...base, connection: 'closed' })).toBe(false);
  });
});

describe('latestAssistantId', () => {
  it('returns the last assistant entry, skipping later user and system notes', () => {
    const messages: ChatEntry[] = [
      { id: 'a1', role: 'assistant', text: 'first' },
      { id: 'u1', role: 'user', text: 'question' },
      { id: 'a2', role: 'assistant', text: 'second' },
      { id: 't1', role: 'thinking', text: 'hmm' },
      { id: 's1', role: 'system', text: 'note' },
    ];
    expect(latestAssistantId(messages)).toBe('a2');
    expect(latestAssistantId([{ id: 'u', role: 'user', text: 'only' }])).toBeUndefined();
  });
});

describe('agentsNeedAttention', () => {
  it.each(['failed', 'error', 'stopped', 'interrupted', 'cancelled', 'aborted'])(
    'flags a worker that did work and ended %s',
    (status) => {
      expect(agentsNeedAttention([agent(status, { iterations: 1 })])).toBe(true);
    },
  );

  it('ignores healthy, active and never-worked agents', () => {
    expect(agentsNeedAttention([agent('completed', { iterations: 3 })])).toBe(false);
    expect(agentsNeedAttention([agent('running', { iterations: 1 })])).toBe(false);
    expect(agentsNeedAttention([])).toBe(false);
  });

  it('treats a terminal failure status as work even without counters', () => {
    // hasAgentWork counts terminal statuses as work, so a bare failure still surfaces.
    expect(agentsNeedAttention([agent('failed')])).toBe(true);
  });
});

describe('autoSubmitAllowed', () => {
  const allowed = {
    prefs: { autonomy: 'auto', yolo: true } as Record<string, unknown>,
    autoEligible: true as boolean | undefined,
    hasDraft: false,
    queued: 0,
    autoLimitReached: false,
    connection: 'open',
    ready: true,
    locked: false,
  };

  it('allows the countdown when every condition holds, with YOLO or YOLO+', () => {
    expect(autoSubmitAllowed(allowed)).toBe(true);
    expect(autoSubmitAllowed({ ...allowed, prefs: { autonomy: 'auto', yoloPlus: true } })).toBe(
      true,
    );
  });

  it.each([
    ['autonomy is suggest', { prefs: { autonomy: 'suggest', yolo: true } }],
    ['autonomy is missing', { prefs: { yolo: true } }],
    ['neither YOLO nor YOLO+', { prefs: { autonomy: 'auto' } }],
    ['YOLO is only truthy, not true', { prefs: { autonomy: 'auto', yolo: 'true' } }],
    ['the reply is not eligible', { autoEligible: false }],
    ['eligibility is unknown', { autoEligible: undefined }],
    ['the user has a draft', { hasDraft: true }],
    ['messages are queued', { queued: 1 }],
    ['the auto streak is exhausted', { autoLimitReached: true }],
    ['the socket is reconnecting', { connection: 'connecting' }],
    ['the session is not ready', { ready: false }],
    ['the workspace is locked', { locked: true }],
  ])('refuses when %s', (_, change) => {
    expect(autoSubmitAllowed({ ...allowed, ...change })).toBe(false);
  });
});
