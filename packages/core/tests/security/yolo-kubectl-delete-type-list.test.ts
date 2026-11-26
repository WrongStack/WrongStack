import { describe, expect, it } from 'vitest';
import { classifyDestructiveCommand } from '../../src/security/yolo-risk.js';

/**
 * kubectl takes a comma-separated TYPE list (`kubectl delete pod,service baz
 * foo`, from `kubectl delete --help`) and deletes every listed type. The gate
 * matched the whole list against the namespace / persistent-volume patterns,
 * so a namespace or PVC inside a list was auto-approved under YOLO.
 */
describe('kubectl delete with a TYPE list', () => {
  it.each([
    'kubectl delete pods,ns prod',
    'kubectl delete namespace,deployment prod',
    'kubectl delete deploy,pvc data',
    'kubectl delete -n x svc,persistentvolumes/pv1',
  ])('gates `%s`', (cmd) => {
    expect(classifyDestructiveCommand(cmd, undefined)).toBe('publish');
  });

  it('a list without namespaces or volumes stays ungated', () => {
    expect(
      classifyDestructiveCommand('kubectl delete pods,services web', undefined),
    ).toBeUndefined();
  });
});
