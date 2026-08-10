/**
 * `refreshDomainTermsMirror` — focused contract tests.
 *
 * Contract: the helper regenerates `.wrongstack/domain-terms.md`
 * from the current SAGE state and never throws on a working
 * MemoryPort. The CLI uses this at boot so the host-side file
 * representation cannot drift away from the authoritative
 * SQLite-backed corpus.
 */

import { SageDomainTermExtractor } from '@wrongstack/sage';
import { describe, expect, it, vi } from 'vitest';
import { refreshDomainTermsMirror } from '../../src/wiring/domain-terms-mirror.js';

describe('refreshDomainTermsMirror', () => {
  it('delegates to SageDomainTermExtractor.writeDomainTermsFile and returns the path', async () => {
    const fakePort = { kind: 'fake-port' } as never;
    const projectRoot = '/tmp/wstack-mirror-test';
    const extractSpy = vi
      .spyOn(SageDomainTermExtractor.prototype, 'writeDomainTermsFile')
      .mockResolvedValue(`${projectRoot}/.wrongstack/domain-terms.md`);

    const result = await refreshDomainTermsMirror({ memoryStore: fakePort, projectRoot });

    expect(result).toBe(`${projectRoot}/.wrongstack/domain-terms.md`);
    expect(extractSpy).toHaveBeenCalledWith(projectRoot, fakePort);

    extractSpy.mockRestore();
  });

  it('returns null and does not throw when the extractor throws', async () => {
    const fakePort = { kind: 'fake-port' } as never;
    const projectRoot = '/tmp/wstack-mirror-test';
    const extractSpy = vi
      .spyOn(SageDomainTermExtractor.prototype, 'writeDomainTermsFile')
      .mockRejectedValue(new Error('disk full'));

    const result = await refreshDomainTermsMirror({ memoryStore: fakePort, projectRoot });

    expect(result).toBeNull();

    extractSpy.mockRestore();
  });

  it('treats non-Error throw values without unwrapping', async () => {
    const fakePort = { kind: 'fake-port' } as never;
    const projectRoot = '/tmp/wstack-mirror-test';
    const extractSpy = vi
      .spyOn(SageDomainTermExtractor.prototype, 'writeDomainTermsFile')
      .mockRejectedValue('plain string failure');

    const result = await refreshDomainTermsMirror({ memoryStore: fakePort, projectRoot });

    expect(result).toBeNull();

    extractSpy.mockRestore();
  });
});
