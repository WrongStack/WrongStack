import { describe, expect, it } from 'vitest';
import { OlderDaemonError, retireOlderDaemon } from '../src/older-daemon.js';

describe('retireOlderDaemon null-prototype runtimeVersion guard', () => {
  it('handles non-coercible runtimeVersion values without throwing TypeError', () => {
    const err = retireOlderDaemon(
      null,
      () => '',
      { pid: 123, runtimeVersion: Object.create(null) },
      'kanban',
    );
    expect(err).toBeInstanceOf(OlderDaemonError);
    expect(err.message).toContain('unknown');
  });
});
