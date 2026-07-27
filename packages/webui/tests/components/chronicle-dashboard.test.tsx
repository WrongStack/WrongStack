import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ChroniclePipelineStrip } from '@/components/ChroniclePipelineStrip';
import type { ChronicleStatus } from '@/types/chronicle';

afterEach(() => {
  cleanup();
});

describe('ChronicleDashboard ownership visibility', () => {
  it('renders the authoritative collect-process-serve pipeline', () => {
    const status: ChronicleStatus = {
      mode: 'server',
      protocolVersion: 1,
      pid: 4242,
      projectRoot: '/project',
      projectDir: '/state/project',
      chronicleDirectory: '/state/project/chronicle',
      endpoint: '/state/project/chronicle.sock',
      startedAt: '2026-07-27T00:00:00.000Z',
      checkedAt: 1,
      uptimeMs: 10_000,
      clients: 3,
      activeRequests: 1,
      journal: { pendingEvents: 0, rejectedEvents: 0, largestBatch: 4 },
      watcher: { active: true, watchedFiles: 12 },
      memory: { rss: 1, heapUsed: 1, heapTotal: 2, external: 0 },
      pipeline: {
        collection: 'session-event-adapters',
        processing: 'project-chronicle-server',
        storage: '/state/project/chronicle',
        serving: 'webui-server',
      },
    };
    render(<ChroniclePipelineStrip status={status} />);

    expect(screen.getByText('Chronicle ownership')).toBeTruthy();
    expect(screen.getByText('session-event-adapters')).toBeTruthy();
    expect(screen.getByText('project-chronicle-server')).toBeTruthy();
    expect(screen.getByText('webui-server')).toBeTruthy();
    expect(screen.getByText('state/project/chronicle')).toBeTruthy();
  });
});
