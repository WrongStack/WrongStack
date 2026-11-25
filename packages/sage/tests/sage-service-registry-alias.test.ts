import { describe, expect, it } from 'vitest';
import {
  clearSageServiceBackends,
  recordSageServiceBackend,
  sageServiceBackendFor,
} from '../src/memory-service-registry.js';

describe('sageServiceBackendFor defensive copy', () => {
  it('does not allow caller mutation to corrupt the stored backend record', () => {
    clearSageServiceBackends();
    recordSageServiceBackend('/tmp/sage-alias-test', 'local', '/tmp/data');
    const first = sageServiceBackendFor('/tmp/sage-alias-test');
    if (first) first.backend = 'wrongmemory';
    const second = sageServiceBackendFor('/tmp/sage-alias-test');
    clearSageServiceBackends();
    expect(second).toEqual({ backend: 'local', dataRoot: '/tmp/data' });
  });
});
