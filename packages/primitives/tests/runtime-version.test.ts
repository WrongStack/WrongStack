import { describe, expect, it } from 'vitest';
import packageInfo from '../package.json' with { type: 'json' };
import {
  assertDaemonRuntimeVersion,
  shouldReplaceOlderDaemon,
  WRONGSTACK_RUNTIME_VERSION,
  withDaemonVersion,
} from '../src/runtime-version.js';

describe('daemon release health', () => {
  it('verifies the expected release after restart', () => {
    expect(() => assertDaemonRuntimeVersion(WRONGSTACK_RUNTIME_VERSION)).not.toThrow();
  });
  it.each(['0.0.1', '999.0.0', undefined, null, ''])(
    'rejects unverified replacement version %s',
    (version) => {
      expect(() => assertDaemonRuntimeVersion(version)).toThrow(
        `expected ${WRONGSTACK_RUNTIME_VERSION}`,
      );
    },
  );
  it('uses the package release and keeps matching daemons healthy', () => {
    expect(WRONGSTACK_RUNTIME_VERSION).toBe(packageInfo.version);
    expect(
      withDaemonVersion({ status: 'healthy', detail: 'Ready.' }, WRONGSTACK_RUNTIME_VERSION),
    ).toEqual({
      status: 'healthy',
      detail: `Ready. WrongStack ${packageInfo.version}.`,
      daemonVersion: WRONGSTACK_RUNTIME_VERSION,
    });
  });

  it('reports the daemon release so a stale build is identifiable', () => {
    expect(
      withDaemonVersion({ status: 'healthy', detail: 'Ready.' }, '0.9.0', '1.0.0').daemonVersion,
    ).toBe('0.9.0');
  });

  it('leaves a legacy daemon unreported rather than inventing a release', () => {
    expect(
      withDaemonVersion({ status: 'healthy', detail: 'Ready.' }, undefined, '1.0.0').daemonVersion,
    ).toBeUndefined();
  });

  it.each(['0.9.0', '2.0.0', undefined, null, 17, ''])(
    'surfaces skew or legacy version %s',
    (version) => {
      const result = withDaemonVersion({ status: 'healthy', detail: 'Ready.' }, version, '1.0.0');
      expect(result.status).toBe('degraded');
      expect(result.versionMismatch).toBe(true);
      expect(result.detail).toContain('client 1.0.0');
      expect(result.detail.toLowerCase()).toContain('restart');
    },
  );

  it('retains an existing failure and its diagnostic', () => {
    const result = withDaemonVersion({ status: 'error', detail: 'Database damaged.' }, '0.9.0');
    expect(result.status).toBe('error');
    expect(result.detail).toContain('Database damaged.');
  });

  it.each(['offline', 'unavailable'])('does not invent version skew for %s services', (status) => {
    const service = { status, detail: 'Sleeping.' };
    expect(withDaemonVersion(service, undefined)).toBe(service);
  });
});

describe('replacing an older project daemon', () => {
  it('replaces only a daemon that reports a strictly older release', () => {
    expect(shouldReplaceOlderDaemon('1.7.1', '1.7.2')).toBe(true);
    expect(shouldReplaceOlderDaemon('1.6.9', '1.7.0')).toBe(true);
    expect(shouldReplaceOlderDaemon('0.9.99', '1.0.0')).toBe(true);
    // A daemon that reports no release keeps being reused, as before.
    expect(shouldReplaceOlderDaemon(undefined, '1.7.2')).toBe(false);
    expect(shouldReplaceOlderDaemon('', '1.7.2')).toBe(false);
  });
  it('reuses a daemon of the same or a newer release, so installations converge', () => {
    expect(shouldReplaceOlderDaemon('1.7.2', '1.7.2')).toBe(false);
    expect(shouldReplaceOlderDaemon('1.8.0', '1.7.2')).toBe(false);
    expect(shouldReplaceOlderDaemon('1.10.0', '1.9.9')).toBe(false);
  });
  it('never replaces from or against a version it cannot order', () => {
    expect(shouldReplaceOlderDaemon('1.7.1', '1.8.0-rc.1')).toBe(false);
    expect(shouldReplaceOlderDaemon('1.7.1', 'development')).toBe(false);
    expect(shouldReplaceOlderDaemon('1.7.1-beta', '1.7.2')).toBe(false);
  });
  it('can be turned off', () => {
    const previous = process.env['WRONGSTACK_DAEMON_REPLACE_OLDER'];
    process.env['WRONGSTACK_DAEMON_REPLACE_OLDER'] = '0';
    try {
      expect(shouldReplaceOlderDaemon('1.0.0', '1.7.2')).toBe(false);
    } finally {
      if (previous === undefined) delete process.env['WRONGSTACK_DAEMON_REPLACE_OLDER'];
      else process.env['WRONGSTACK_DAEMON_REPLACE_OLDER'] = previous;
    }
  });
});
