import { describe, expect, it } from 'vitest';
import { parseEnvironmentProfile, validateEnvironmentProfile } from '../src/environment-profile.js';

const profile = (protocol: unknown) => ({
  version: 1,
  name: 'project',
  image: 'trusted:1',
  setupCommands: [],
  setupTimeoutMs: 1000,
  services: [],
  caches: [],
  ports: [{ name: 'preview', port: 3000, protocol }],
});
const document = (protocol: unknown) =>
  JSON.stringify({
    type: 'wrongstack.environment',
    version: 1,
    profile: profile(protocol),
  });
const malformed: Array<[string, unknown]> = [
  ['http array', ['http']],
  ['tcp array', ['tcp']],
  ['nested http array', [['http']]],
  ['nested tcp array', [['tcp']]],
  ['empty array', []],
  ['plain object', {}],
  ['null', null],
  ['boolean', true],
  ['number', 42],
  ['unsupported string', 'udp'],
  ['uppercase string', 'HTTP'],
  ['padded string', ' http '],
];

describe('environment port protocol literal validation', () => {
  it.each(['http', 'tcp'])('accepts the literal %s without rewriting it', (protocol) => {
    expect(() => validateEnvironmentProfile(profile(protocol))).not.toThrow();
    expect(parseEnvironmentProfile(document(protocol)).ports[0]?.protocol).toBe(protocol);
  });

  it.each(malformed)('rejects %s while parsing the portable JSON document', (_label, protocol) => {
    expect(() => parseEnvironmentProfile(document(protocol))).toThrow('Ports require unique names');
  });

  it.each(malformed)('rejects %s at the runtime object boundary', (_label, protocol) => {
    expect(() => validateEnvironmentProfile(profile(protocol))).toThrow(
      'Ports require unique names',
    );
  });

  it('does not invoke conversion hooks while validating an unknown protocol', () => {
    let calls = 0;
    const protocol = {
      toString() {
        calls++;
        return 'http';
      },
    };
    expect(() => validateEnvironmentProfile(profile(protocol))).toThrow(
      'Ports require unique names',
    );
    expect(calls).toBe(0);
  });
});
