import { describe, expect, it } from 'vitest';
import { backgroundServices } from '../src/BackgroundServices';

describe('background services', () => {
  it('reads health and offers control only for services the engine can stop', () => {
    const report = backgroundServices({
      overall: 'degraded',
      checkedAt: 10,
      services: [
        { id: 'webui', label: 'WebUI', status: 'healthy', required: true },
        { id: 'governance', label: 'Governance', status: 'healthy' },
        {
          id: 'kanban',
          label: 'Kanban',
          status: 'degraded',
          daemonVersion: '1.2.0',
          versionMismatch: true,
          ownerPid: 42,
          control: 'shutdown',
        },
        { id: 'sage', label: 'Memory', status: 'offline', control: 'none', lastError: 'gone' },
        { label: 'no id' },
      ],
    });
    expect(report.overall).toBe('degraded');
    expect(report.services.map((service) => [service.id, service.controllable])).toEqual([
      ['webui', false],
      ['governance', false],
      ['kanban', true],
      ['sage', false],
    ]);
    expect(report.services[2]).toMatchObject({ version: '1.2.0', versionMismatch: true, pid: 42 });
    expect(report.services[3]?.lastError).toBe('gone');
  });
});
