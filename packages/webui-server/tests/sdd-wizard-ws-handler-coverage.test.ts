import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WebSocket } from 'ws';

vi.mock('ws', () => {
  const MockWebSocket: any = vi.fn();
  MockWebSocket.OPEN = 1;
  MockWebSocket.CLOSING = 2;
  MockWebSocket.CLOSED = 3;
  return { WebSocket: MockWebSocket };
});

vi.mock('@wrongstack/sdd', () => ({}));

import {
  SddWizardWebSocketHandler,
  type SddWizardDeps,
} from '../src/server/sdd-wizard-ws-handler.js';

function mockWs(): any {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    on: vi.fn(),
  };
}

function makeDriverStub(extra: Record<string, unknown> = {}): any {
  return {
    loadExisting: vi.fn(async () => false),
    getLastAgentText: vi.fn(() => null),
    start: vi.fn(() => 'initial prompt'),
    currentPrompt: vi.fn(() => 'next prompt'),
    phase: vi.fn(() => 'idle' as const),
    submitAnswer: vi.fn(),
    approve: vi.fn(async () => ({ phase: 'spec_review' as const, prompt: 'review prompt' })),
    discard: vi.fn(async () => undefined),
    ingestAgentOutput: vi.fn(async () => undefined),
    setLastAgentText: vi.fn(async () => undefined),
    snapshot: vi.fn(() => ({ phase: 'idle', spec: null })),
    ensureTaskGraph: vi.fn(async () => ({ id: 'g1', nodes: [] })),
    setLastRunId: vi.fn(async () => undefined),
    builder: { saveSession: vi.fn(async () => undefined) },
    ...extra,
  };
}

function makeDeps(extra: Partial<SddWizardDeps> = {}): SddWizardDeps {
  return {
    makeDriver: vi.fn(() => makeDriverStub()),
    runInterviewTurn: vi.fn(async (_prompt: string) => 'agent response'),
    startRun: vi.fn(async () => ({ runId: 'run-1' })),
    ...extra,
  };
}

describe('SddWizardWebSocketHandler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('addClient / lifecycle', () => {
    it('registers a client without crashing', async () => {
      const handler = new SddWizardWebSocketHandler(makeDeps());
      const ws = mockWs();
      handler.addClient(ws);
      // Wait for bootstrap promise
      await vi.waitFor(() => expect(ws.on).toHaveBeenCalled());
    });

    it('sends snapshot to reconnecting client after resume', async () => {
      const deps = makeDeps();
      // Simulate an existing session that loads
      deps.makeDriver = vi.fn(() =>
        makeDriverStub({
          loadExisting: vi.fn(async () => true),
          getLastAgentText: vi.fn(() => 'previous agent text'),
          snapshot: vi.fn(() => ({ phase: 'questioning', spec: { title: 'Test' } })),
        }),
      );
      const handler = new SddWizardWebSocketHandler(deps);
      const ws = mockWs();
      handler.addClient(ws);
      await vi.waitFor(() => {
        expect(ws.send).toHaveBeenCalled();
      });
      const sent = ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
      const types = sent.map((m: any) => m.type);
      expect(types).toContain('sdd.spec.snapshot');
      expect(types).toContain('sdd.spec.agent_text');
    });

    it('sends resume error when bootstrap fails', async () => {
      const deps = makeDeps({
        ensureReady: vi.fn(async () => {
          throw new Error('context fail');
        }),
      });
      // makeDriver.loadExisting throws
      deps.makeDriver = vi.fn(() =>
        makeDriverStub({
          loadExisting: vi.fn(async () => {
            throw new Error('IPC down');
          }),
        }),
      );
      const handler = new SddWizardWebSocketHandler(deps);
      const ws = mockWs();
      handler.addClient(ws);
      await vi.waitFor(() => {
        expect(ws.send).toHaveBeenCalled();
      });
      const sent = ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
      const types = sent.map((m: any) => m.type);
      expect(types).toContain('sdd.spec.error');
    });
  });

  describe('handleMessage — sdd.spec.start', () => {
    it('starts a new interview when goal is provided', async () => {
      const deps = makeDeps();
      const handler = new SddWizardWebSocketHandler(deps);
      const ws = mockWs();
      handler.addClient(ws);
      await vi.waitFor(() => expect(ws.on).toHaveBeenCalled());

      await handler.handleMessage({
        type: 'sdd.spec.start',
        payload: { goal: 'Build a REST API' },
      });

      expect(deps.runInterviewTurn).toHaveBeenCalled();
    });

    it('sends error when goal is empty', async () => {
      const handler = new SddWizardWebSocketHandler(makeDeps());
      const ws = mockWs();
      handler.addClient(ws);
      await vi.waitFor(() => expect(ws.on).toHaveBeenCalled());

      await handler.handleMessage({ type: 'sdd.spec.start', payload: { goal: '' } });

      const sent = ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
      const types = sent.map((m: any) => m.type);
      expect(types).toContain('sdd.spec.error');
    });

    it('surfaces existing interview without clobbering when force is not set', async () => {
      const driverStub = makeDriverStub({
        loadExisting: vi.fn(async () => true),
        phase: vi.fn(() => 'questioning' as const),
      });
      const deps = makeDeps({ makeDriver: vi.fn(() => driverStub) });
      const handler = new SddWizardWebSocketHandler(deps);
      const ws = mockWs();
      handler.addClient(ws);
      await vi.waitFor(() => expect(ws.on).toHaveBeenCalled());

      await handler.handleMessage({ type: 'sdd.spec.start', payload: { goal: 'new goal' } });

      const sent = ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
      const errorMessages = sent.filter((m: any) => m.type === 'sdd.spec.error');
      expect(errorMessages.length).toBeGreaterThan(0);
      expect(errorMessages[0].payload.message).toContain('already in progress');
    });

    it('force-start discards existing session and starts fresh', async () => {
      const driverStub = makeDriverStub({
        loadExisting: vi.fn(async () => true),
        phase: vi.fn(() => 'questioning' as const),
        discard: vi.fn(async () => undefined),
      });
      const deps = makeDeps({ makeDriver: vi.fn(() => driverStub) });
      const handler = new SddWizardWebSocketHandler(deps);
      const ws = mockWs();
      handler.addClient(ws);
      await vi.waitFor(() => expect(ws.on).toHaveBeenCalled());

      await handler.handleMessage({
        type: 'sdd.spec.start',
        payload: { goal: 'new', force: true },
      });

      expect(driverStub.discard).toHaveBeenCalled();
      expect(deps.runInterviewTurn).toHaveBeenCalled();
    });
  });

  describe('handleMessage — sdd.spec.discard', () => {
    it('discards the current session', async () => {
      const driverStub = makeDriverStub();
      const deps = makeDeps({ makeDriver: vi.fn(() => driverStub) });
      const handler = new SddWizardWebSocketHandler(deps);
      const ws = mockWs();
      handler.addClient(ws);
      await vi.waitFor(() => expect(ws.on).toHaveBeenCalled());

      await handler.handleMessage({ type: 'sdd.spec.discard' });

      const sent = ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
      const types = sent.map((m: any) => m.type);
      expect(types).toContain('sdd.spec.snapshot');
    });
  });

  describe('handleMessage — sdd.spec.get', () => {
    it('sends snapshot when driver exists', async () => {
      const driverStub = makeDriverStub({
        loadExisting: vi.fn(async () => true),
        snapshot: vi.fn(() => ({ phase: 'spec_review', spec: { title: 'T' } })),
      });
      const deps = makeDeps({ makeDriver: vi.fn(() => driverStub) });
      const handler = new SddWizardWebSocketHandler(deps);
      const ws = mockWs();
      handler.addClient(ws);
      await vi.waitFor(() => expect(ws.on).toHaveBeenCalled());

      await handler.handleMessage({ type: 'sdd.spec.get' });

      const sent = ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
      const types = sent.map((m: any) => m.type);
      expect(types).toContain('sdd.spec.snapshot');
    });

    it('is a no-op when no driver exists', async () => {
      const handler = new SddWizardWebSocketHandler(makeDeps());
      const ws = mockWs();
      handler.addClient(ws);
      await vi.waitFor(() => expect(ws.on).toHaveBeenCalled());

      await handler.handleMessage({ type: 'sdd.spec.get' });
      // May or may not send, but must not throw
      expect(true).toBe(true);
    });
  });

  describe('handleMessage — sdd.run.start', () => {
    it('sends error when no active driver', async () => {
      const handler = new SddWizardWebSocketHandler(makeDeps());
      const ws = mockWs();
      handler.addClient(ws);
      await vi.waitFor(() => expect(ws.on).toHaveBeenCalled());

      await handler.handleMessage({ type: 'sdd.run.start', payload: {} });

      const sent = ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
      const types = sent.map((m: any) => m.type);
      expect(types).toContain('sdd.spec.error');
    });

    it('starts a run when driver has a task graph', async () => {
      const driverStub = makeDriverStub({
        loadExisting: vi.fn(async () => true),
        ensureTaskGraph: vi.fn(async () => ({ id: 'g1', nodes: [] })),
        phase: vi.fn(() => 'task_review' as const),
        approve: vi.fn(async () => ({ phase: 'executing' as const, prompt: '' })),
      });
      const deps = makeDeps({
        makeDriver: vi.fn(() => driverStub),
        startRun: vi.fn(async () => ({ runId: 'run-42' })),
      });
      const handler = new SddWizardWebSocketHandler(deps);
      const ws = mockWs();
      handler.addClient(ws);
      await vi.waitFor(() => expect(ws.on).toHaveBeenCalled());

      await handler.handleMessage({ type: 'sdd.run.start', payload: {} });

      const sent = ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
      const types = sent.map((m: any) => m.type);
      expect(types).toContain('sdd.run.started');
    });
  });

  describe('handleMessage — sdd.run.from_graph', () => {
    it('sends error when graphId is empty', async () => {
      const handler = new SddWizardWebSocketHandler(makeDeps());
      const ws = mockWs();
      handler.addClient(ws);
      await vi.waitFor(() => expect(ws.on).toHaveBeenCalled());

      await handler.handleMessage({ type: 'sdd.run.from_graph', payload: { graphId: '' } });

      const sent = ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
      const types = sent.map((m: any) => m.type);
      expect(types).toContain('sdd.spec.error');
    });

    it('sends error when startRunFromGraphId is not available', async () => {
      const handler = new SddWizardWebSocketHandler(makeDeps());
      const ws = mockWs();
      handler.addClient(ws);
      await vi.waitFor(() => expect(ws.on).toHaveBeenCalled());

      await handler.handleMessage({ type: 'sdd.run.from_graph', payload: { graphId: 'g1' } });

      const sent = ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
      const types = sent.map((m: any) => m.type);
      expect(types).toContain('sdd.spec.error');
    });

    it('starts run from graph when available', async () => {
      const deps = makeDeps({
        startRunFromGraphId: vi.fn(async () => ({ runId: 'run-g' })),
      });
      const handler = new SddWizardWebSocketHandler(deps);
      const ws = mockWs();
      handler.addClient(ws);
      await vi.waitFor(() => expect(ws.on).toHaveBeenCalled());

      await handler.handleMessage({ type: 'sdd.run.from_graph', payload: { graphId: 'g1' } });

      const sent = ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
      const types = sent.map((m: any) => m.type);
      expect(types).toContain('sdd.run.started');
    });
  });

  describe('handleMessage — sdd.run.from_spec', () => {
    it('sends error when specId is empty', async () => {
      const handler = new SddWizardWebSocketHandler(makeDeps());
      const ws = mockWs();
      handler.addClient(ws);
      await vi.waitFor(() => expect(ws.on).toHaveBeenCalled());

      await handler.handleMessage({ type: 'sdd.run.from_spec', payload: { specId: '' } });

      const sent = ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
      const types = sent.map((m: any) => m.type);
      expect(types).toContain('sdd.spec.error');
    });

    it('sends error when not available on host', async () => {
      const handler = new SddWizardWebSocketHandler(makeDeps());
      const ws = mockWs();
      handler.addClient(ws);
      await vi.waitFor(() => expect(ws.on).toHaveBeenCalled());

      await handler.handleMessage({ type: 'sdd.run.from_spec', payload: { specId: 's1' } });

      const sent = ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
      const types = sent.map((m: any) => m.type);
      expect(types).toContain('sdd.spec.error');
    });

    it('sends error when no graph found for spec', async () => {
      const deps = makeDeps({
        resolveGraphIdForSpec: vi.fn(async () => null),
        startRunFromGraphId: vi.fn(async () => ({ runId: 'r' })),
      });
      const handler = new SddWizardWebSocketHandler(deps);
      const ws = mockWs();
      handler.addClient(ws);
      await vi.waitFor(() => expect(ws.on).toHaveBeenCalled());

      await handler.handleMessage({ type: 'sdd.run.from_spec', payload: { specId: 's1' } });

      const sent = ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
      const errorMessages = sent.filter((m: any) => m.type === 'sdd.spec.error');
      expect(errorMessages.length).toBeGreaterThan(0);
    });

    it('starts run from spec when graph found', async () => {
      const deps = makeDeps({
        resolveGraphIdForSpec: vi.fn(async () => 'graph-1'),
        startRunFromGraphId: vi.fn(async () => ({ runId: 'run-s' })),
      });
      const handler = new SddWizardWebSocketHandler(deps);
      const ws = mockWs();
      handler.addClient(ws);
      await vi.waitFor(() => expect(ws.on).toHaveBeenCalled());

      await handler.handleMessage({ type: 'sdd.run.from_spec', payload: { specId: 'spec-1' } });

      const sent = ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
      const types = sent.map((m: any) => m.type);
      expect(types).toContain('sdd.run.started');
    });
  });

  describe('handleMessage — unknown type', () => {
    it('does not throw on unknown message type', async () => {
      const handler = new SddWizardWebSocketHandler(makeDeps());
      const ws = mockWs();
      handler.addClient(ws);
      await vi.waitFor(() => expect(ws.on).toHaveBeenCalled());

      await handler.handleMessage({ type: 'unknown.type', payload: {} });
      // Should not throw
      expect(true).toBe(true);
    });
  });
});
