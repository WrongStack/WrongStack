import { describe, expect, it } from 'vitest';
import { environmentDraftCodec, environmentDraftKey } from '../src/automation-environment-draft';
import { environmentDraft } from '../src/automation-environment-model';

const base = environmentDraft(undefined, 'node:24');
const draft = {
  ...base,
  setup: 'bun install',
  services: [{ name: 'db', image: 'postgres:17', command: '', health: '', envNames: 'PGPASSWORD' }],
  ports: [{ name: 'web', port: '3000', protocol: 'http' as const }],
};

describe('automation environment draft', () => {
  it('round-trips unapplied edits with the environment they came from', () => {
    expect(environmentDraftCodec.parse(environmentDraftCodec.serialize({ base, draft }))).toEqual({
      base,
      draft,
    });
    expect(environmentDraftCodec.parse(null)).toBeNull();
  });
  it('refuses foreign or malformed envelopes', () => {
    for (const value of [
      { version: 2, base, draft },
      { version: 1, base, draft: { ...draft, setup: 3 } },
      {
        version: 1,
        base,
        draft: { ...draft, ports: [{ name: 'web', port: '1', protocol: 'udp' }] },
      },
      { version: 1, base, draft: { ...draft, services: [{ name: 'db' }] } },
      { version: 1, base, draft: { ...draft, setup: 'x'.repeat(600_000) } },
      { version: 1, draft },
    ])
      expect(() => environmentDraftCodec.parse(value)).toThrow(/unsupported format/);
  });
  it('keys each job separately within a project', async () => {
    const job = await environmentDraftKey('p1', 'job-1');
    expect(job).toMatch(/^automation-environment:[0-9a-f]{64}$/);
    expect(await environmentDraftKey('p1', 'job-1')).toBe(job);
    expect(await environmentDraftKey('p1', 'job-2')).not.toBe(job);
    expect(await environmentDraftKey('p2', 'job-1')).not.toBe(job);
    expect(await environmentDraftKey('p1', undefined)).not.toBe(job);
  });
});
