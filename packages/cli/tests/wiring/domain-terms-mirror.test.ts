/**
 * `refreshDomainTermsMirror` — focused contract tests.
 *
 * Contract: the helper regenerates `.wrongstack/domain-terms.md`
 * with the canonical placeholder at CLI boot and never throws on a
 * working filesystem. The CLI uses this at boot so the on-disk
 * mirror path always exists; the per-turn middleware and
 * session-end commit extractor overwrite the file with the freshly
 * extracted terms on the next opportunity.
 */

import { SageDomainTermExtractor } from '@wrongstack/sage';
import { describe, expect, it, vi } from 'vitest';
import { refreshDomainTermsMirror } from '../../src/wiring/domain-terms-mirror.js';

describe('refreshDomainTermsMirror', () => {
  it('delegates to SageDomainTermExtractor.writeDomainTermsFile with an empty term list and returns the path', async () => {
    const projectRoot = '/tmp/wstack-mirror-test';
    const extractSpy = vi
      .spyOn(SageDomainTermExtractor.prototype, 'writeDomainTermsFile')
      .mockResolvedValue(`${projectRoot}/.wrongstack/domain-terms.md`);

    const result = await refreshDomainTermsMirror({ projectRoot });

    expect(result).toBe(`${projectRoot}/.wrongstack/domain-terms.md`);
    expect(extractSpy).toHaveBeenCalledWith(projectRoot, []);

    extractSpy.mockRestore();
  });

  it('returns null and does not throw when the extractor throws', async () => {
    const projectRoot = '/tmp/wstack-mirror-test';
    const extractSpy = vi
      .spyOn(SageDomainTermExtractor.prototype, 'writeDomainTermsFile')
      .mockRejectedValue(new Error('disk full'));

    const result = await refreshDomainTermsMirror({ projectRoot });

    expect(result).toBeNull();

    extractSpy.mockRestore();
  });

  it('treats non-Error throw values without unwrapping', async () => {
    const projectRoot = '/tmp/wstack-mirror-test';
    const extractSpy = vi
      .spyOn(SageDomainTermExtractor.prototype, 'writeDomainTermsFile')
      .mockRejectedValue('plain string failure');

    const result = await refreshDomainTermsMirror({ projectRoot });

    expect(result).toBeNull();

    extractSpy.mockRestore();
  });
});
