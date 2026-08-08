import type { SessionRegistryEntry } from '@wrongstack/core/storage';
import { describe, expect, it } from 'vitest';
import {
  joinSessionRegistryWithWebUIInstances,
  type WebUIInstanceRecord,
} from '../src/server/instance-registry.js';

const session = (overrides: Partial<SessionRegistryEntry> = {}): SessionRegistryEntry => ({
  sessionId: 'sess-a',
  projectSlug: 'project-a',
  projectRoot: '/tmp/project-a',
  projectName: 'project-a',
  workingDir: '/tmp/project-a',
  clientType: 'webui',
  status: 'active',
  pid: 1001,
  startedAt: '2026-08-08T00:00:00.000Z',
  lastHeartbeatAt: '2026-08-08T00:00:01.000Z',
  agentCount: 0,
  agents: [],
  ...overrides,
});

const instance = (overrides: Partial<WebUIInstanceRecord> = {}): WebUIInstanceRecord => ({
  pid: 1001,
  surface: 'webui',
  httpPort: 3456,
  host: '127.0.0.1',
  projectRoot: '/tmp/project-a',
  projectName: 'project-a',
  startedAt: '2026-08-08T00:00:00.000Z',
  url: 'http://127.0.0.1:3456',
  role: 'session-child',
  sessionId: 'sess-a',
  runtimeId: 'runtime-a',
  attachable: true,
  authToken: 'token-a',
  ...overrides,
});

describe('joinSessionRegistryWithWebUIInstances', () => {
  it('marks a live session-child endpoint as attachable', () => {
    const [candidate] = joinSessionRegistryWithWebUIInstances({
      sessions: [session()],
      instances: [instance()],
      projectRoot: '/tmp/project-a',
    });

    expect(candidate).toMatchObject({
      sessionId: 'sess-a',
      attachable: true,
      endpoint: {
        host: '127.0.0.1',
        httpPort: 3456,
        url: 'http://127.0.0.1:3456',
        authToken: 'token-a',
      },
    });
    expect(candidate?.degradedReason).toBeUndefined();
  });

  it('reports a live session without a WebUI endpoint as degraded', () => {
    const [candidate] = joinSessionRegistryWithWebUIInstances({
      sessions: [session()],
      instances: [],
      projectSlug: 'project-a',
    });

    expect(candidate).toMatchObject({
      sessionId: 'sess-a',
      attachable: false,
      degradedReason: 'live-session-no-webui-endpoint',
    });
  });

  it('reports endpoint owner mismatches as degraded', () => {
    const [candidate] = joinSessionRegistryWithWebUIInstances({
      sessions: [session()],
      instances: [instance({ pid: 2002 })],
      projectRoot: '/tmp/project-a',
    });

    expect(candidate).toMatchObject({
      sessionId: 'sess-a',
      attachable: false,
      degradedReason: 'endpoint-owner-mismatch',
    });
  });

  it('requires session-child role and a session id for attachment', () => {
    const [candidate] = joinSessionRegistryWithWebUIInstances({
      sessions: [session()],
      instances: [instance({ role: 'standalone', sessionId: undefined })],
      projectRoot: '/tmp/project-a',
    });

    expect(candidate).toMatchObject({
      sessionId: 'sess-a',
      attachable: false,
      degradedReason: 'endpoint-missing-session-id',
    });
  });

  it('filters by project root using platform-aware normalization', () => {
    const candidates = joinSessionRegistryWithWebUIInstances({
      sessions: [session(), session({ sessionId: 'sess-b', projectRoot: '/tmp/project-b' })],
      instances: [instance()],
      projectRoot: '/tmp/project-a',
    });

    expect(candidates.map((candidate) => candidate.sessionId)).toEqual(['sess-a']);
  });
});
