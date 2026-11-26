import { describe, expect, it } from 'vitest';
import { detectDanger } from '../src/_danger-detect.js';

/**
 * Tools-side twins of the core YOLO gates:
 * - `cmd /c <payload>` hid its payload: `/c` and `/k` were not payload flags,
 *   so a destructive command inside them was never classified.
 * - Yarn 2+ publishes with `yarn npm publish`; the publish rule stopped at `npm`.
 * - kubectl accepts a comma-separated TYPE list (`pods,ns prod`), which deletes
 *   every listed type; only the bare type was matched.
 */

describe('cmd /c and /k payloads are classified', () => {
  it.each([
    ['cmd', ['/c', 'git push --force origin main']],
    ['cmd', ['/C', 'git push --force origin main']],
    ['cmd.exe', ['/k', 'npm publish']],
  ])('%s %j → destructive', (cmd, args) => {
    expect(detectDanger(cmd, args).level).toBe('destructive');
  });

  it('control: a harmless cmd /c payload is not destructive', () => {
    expect(detectDanger('cmd', ['/c', 'echo hi']).level).not.toBe('destructive');
  });
});

describe('yarn npm publish is a registry publish', () => {
  it.each([
    [['npm', 'publish']],
    [['npm', 'publish', '--access', 'public']],
    [['workspaces', 'foreach', '-A', 'npm', 'publish']],
  ])('yarn %j → destructive', (args) => {
    expect(detectDanger('yarn', args).level).toBe('destructive');
  });

  it('control: yarn npm info is not destructive', () => {
    expect(detectDanger('yarn', ['npm', 'info', 'react']).level).not.toBe('destructive');
  });
});

describe('kubectl delete with a TYPE list', () => {
  it.each([
    [['delete', 'pods,ns', 'prod']],
    [['delete', 'namespace,deployment', 'prod']],
    [['delete', 'deploy,pvc', 'data']],
    [['delete', '-n', 'x', 'svc,persistentvolumes/pv1']],
  ])('kubectl %j → destructive', (args) => {
    expect(detectDanger('kubectl', args).level).toBe('destructive');
  });

  it('control: kubectl delete pods,svc stays below destructive-namespace', () => {
    const r = detectDanger('kubectl', ['delete', 'pods,svc', 'web']);
    expect(r.matchedRule).not.toBe('kubectl-delete-namespace');
  });
});
