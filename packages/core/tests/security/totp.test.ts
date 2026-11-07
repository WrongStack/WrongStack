import { describe, expect, it } from 'vitest';
import {
  areSubagentCompanionsAllowed,
  areSubagentsAllowed,
  isSubagentPolicyLocked,
  seedSessionSubagentPolicy,
  setSessionSubagentPolicy,
  subagentPolicyMode,
} from '../../src/security/session-subagent-policy.js';
import {
  base32Decode,
  base32Encode,
  buildOtpAuthUri,
  generateRecoveryCodes,
  generateTotp,
  generateTotpSecret,
  hashRecoveryCode,
  hotp,
  verifyRecoveryCode,
  verifyTotp,
  verifyTotpCounter,
} from '../../src/security/totp.js';

describe('base32', () => {
  it('encodes and decodes round-trip', () => {
    const buf = Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0]);
    const encoded = base32Encode(buf);
    const decoded = base32Decode(encoded);
    expect(decoded).toEqual(buf);
  });

  it('handles empty input', () => {
    expect(base32Encode(Buffer.alloc(0))).toBe('');
    expect(base32Decode('')).toEqual(Buffer.alloc(0));
  });

  it('tolerates lowercase and whitespace', () => {
    const upper = 'JBSWY3DPEHPK3PXP';
    expect(base32Decode(upper.toLowerCase())).toEqual(base32Decode(upper));
    expect(base32Decode(' jbsw y3dp ehpk 3pxp ')).toEqual(base32Decode(upper));
  });

  it('rejects invalid characters', () => {
    expect(() => base32Decode('INVALID0')).toThrow('Invalid base32 character');
  });
});

describe('hotp (RFC 4226)', () => {
  // RFC 4226 Appendix D test values. Secret = ASCII "12345678901234567890"
  // (HMAC-SHA1 key), counter = 0..9. These are the canonical interoperability
  // vectors every HOTP/TOTP implementation must match.
  const secret = Buffer.from('12345678901234567890', 'ascii');
  const expected = [
    '755224',
    '287082',
    '359152',
    '969429',
    '338314',
    '254676',
    '287922',
    '162583',
    '399871',
    '520489',
  ];

  it('matches RFC 4226 Appendix D vectors for counters 0–9', () => {
    for (let i = 0; i < 10; i++) {
      expect(hotp(secret, i)).toBe(expected[i]);
    }
  });
});

describe('generateTotp + verifyTotp', () => {
  it('generates a 6-digit code that verifies at the same timestamp', () => {
    const secret = generateTotpSecret();
    const at = Date.now();
    const code = generateTotp(secret, at);
    expect(code).toMatch(/^\d{6}$/);
    expect(verifyTotp(code, secret, at)).toBe(true);
  });

  it('verifies within ±1 window (±30s)', () => {
    const secret = generateTotpSecret();
    const at = 1_700_000_000_000; // arbitrary fixed time
    const code = generateTotp(secret, at);
    // 30s before and after should still verify
    expect(verifyTotp(code, secret, at - 30_000, 1)).toBe(true);
    expect(verifyTotp(code, secret, at + 30_000, 1)).toBe(true);
  });

  it('rejects a code outside the window', () => {
    const secret = generateTotpSecret();
    const at = 1_700_000_000_000;
    const code = generateTotp(secret, at);
    // 90s ahead is outside ±1 window
    expect(verifyTotp(code, secret, at + 90_000, 1)).toBe(false);
  });

  it('rejects wrong-length codes', () => {
    const secret = generateTotpSecret();
    expect(verifyTotp('12345', secret)).toBe(false);
    expect(verifyTotp('1234567', secret)).toBe(false);
  });

  it('rejects non-digit characters', () => {
    const secret = generateTotpSecret();
    const code = generateTotp(secret);
    // Replace ALL digits to guarantee a non-digit result
    const badCode = code.replace(/\d/g, 'a');
    expect(badCode).not.toBe(code); // sanity: replacement actually happened
    expect(verifyTotp(badCode, secret)).toBe(false);
  });

  it('matches RFC 6238 Appendix B vectors (SHA-1, 8-digit)', () => {
    // RFC 6238 §B: secret = 20 bytes "12345678901234567890" (ASCII),
    // 30s step, 8 digits. Times are T0=0, step counts from there.
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'; // base32 of "12345678901234567890" ×1
    const times: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
    ];
    for (const [unixSec, expectedCode] of times) {
      const code = generateTotp(secret, unixSec * 1000, 30, 8);
      expect(code).toBe(expectedCode);
    }
  });
});

describe('buildOtpAuthUri', () => {
  it('produces a well-formed otpauth:// URI', () => {
    const secret = 'JBSWY3DPEHPK3PXP';
    const uri = buildOtpAuthUri(secret, 'admin@example.com');
    expect(uri).toMatch(/^otpauth:\/\/totp\//);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('issuer=WrongStack+HQ');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
    expect(uri).toContain('algorithm=SHA1');
  });
});

describe('recovery codes', () => {
  it('generates 8 unique codes in xxxxxxxx-xxxxxxxx format', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(codes.every((c) => /^\w{8}-\w{8}$/.test(c))).toBe(true);
    expect(new Set(codes).size).toBe(8); // no duplicates
  });

  it('hashes and verifies round-trip', () => {
    const codes = generateRecoveryCodes();
    const hashes = codes.map(hashRecoveryCode);
    // Each code verifies against the hash list
    for (const code of codes) {
      expect(verifyRecoveryCode(code, hashes)).toBe(true);
    }
  });

  it('rejects codes not in the list', () => {
    const hashes = generateRecoveryCodes().map(hashRecoveryCode);
    expect(verifyRecoveryCode('deadbeef-deadbeef', hashes)).toBe(false);
  });

  it('normalizes whitespace and case before hashing', () => {
    const code = 'ABCDEFGH-12345678';
    const hash = hashRecoveryCode(code);
    // Same hash regardless of casing or whitespace
    expect(hashRecoveryCode('abcdefgh-12345678')).toBe(hash);
    expect(hashRecoveryCode(' ABCDEFGH-12345678 ')).toBe(hash);
  });

  it('hash is SHA-256 (64 hex chars)', () => {
    const hash = hashRecoveryCode('test-code-1234');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('consumed code can be removed from list', () => {
    const codes = generateRecoveryCodes();
    const hashes = codes.map(hashRecoveryCode);
    // Consume the first code
    const usedHash = hashRecoveryCode(codes[0]!);
    const remaining = hashes.filter((h) => h !== usedHash);
    expect(remaining).toHaveLength(hashes.length - 1);
    // Remaining codes still verify
    for (const code of codes.slice(1)) {
      expect(verifyRecoveryCode(code, remaining)).toBe(true);
    }
    // Consumed code no longer verifies
    expect(verifyRecoveryCode(codes[0]!, remaining)).toBe(false);
  });
});

describe('generateTotpSecret', () => {
  it('produces a 32-char base32 string (20 bytes)', () => {
    const secret = generateTotpSecret();
    expect(secret).toHaveLength(32);
    // Must be valid base32
    expect(() => base32Decode(secret)).not.toThrow();
  });

  it('produces unique secrets', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();
    expect(a).not.toBe(b);
  });
});

describe('verifyTotp code-shape guard (WS-SEC-LOW)', () => {
  const secret = generateTotpSecret();

  it('rejects a code whose byte length differs from its character length', () => {
    // `code.length` counts UTF-16 units, `Buffer.from(code)` is UTF-8. Six
    // full-width digits are 6 characters and 18 bytes, so they used to clear
    // the length guard and make `timingSafeEqual` THROW
    // (ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH) instead of returning false.
    expect(() => verifyTotp('１２３４５６', secret)).not.toThrow();
    expect(verifyTotp('１２３４５６', secret)).toBe(false);
  });

  it('rejects non-digit codes of the right length instead of throwing', () => {
    for (const bad of ['abcdef', '12 456', '12-456', '１2345６']) {
      expect(() => verifyTotp(bad, secret)).not.toThrow();
      expect(verifyTotp(bad, secret)).toBe(false);
    }
  });

  it('still accepts the genuine current code', () => {
    // The guard must not have narrowed the accepted domain.
    expect(verifyTotp(generateTotp(secret), secret)).toBe(true);
  });

  it('returns undefined rather than throwing from the counter variant', () => {
    expect(verifyTotpCounter('１２３４５６', secret)).toBeUndefined();
  });

  it('does not throw RangeError when verifying at the Unix epoch (atMs = 0) with a negative window offset', () => {
    const codeAtEpoch = generateTotp(secret, 0);
    expect(verifyTotp(codeAtEpoch, secret, 0)).toBe(true);
    expect(verifyTotpCounter('000000', secret, 0)).toBeUndefined();
  });

  it('guards verifyTotpCounter against non-finite atMs, non-positive stepSeconds, negative window, and invalid digits (F91)', () => {
    const now = 1_700_000_000_000;
    const validCode = generateTotp(secret, now);
    expect(verifyTotpCounter(validCode, secret, Number.NaN)).toBeUndefined();
    expect(verifyTotpCounter(validCode, secret, now, 1, 0)).toBeUndefined();
    expect(verifyTotpCounter(validCode, secret, now, 1, -30)).toBeUndefined();
    expect(verifyTotpCounter(validCode, secret, now, -1, 30)).toBeUndefined();
    expect(verifyTotpCounter(validCode, secret, now, 1, 30, 0)).toBeUndefined();
  });

  it('rejects empty and whitespace/hyphen-only recovery codes in hashRecoveryCode and verifyRecoveryCode (F91)', () => {
    const emptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(hashRecoveryCode('')).toBe('');
    expect(hashRecoveryCode(' ---  --- ')).toBe('');
    expect(verifyRecoveryCode(' --- ', [emptySha256])).toBe(false);
  });
});

describe('session subagent policy inheritance and lock seeding (F91)', () => {
  it('falls back to sessionPolicies when ctx.meta is present but has no subagent policy keys', async () => {
    const writerCtx = {
      meta: {} as Record<string, unknown>,
      session: { id: 'sess-f91-reg-policy', append: async () => {} },
    };
    await setSessionSubagentPolicy(writerCtx, 'companions');
    const derivedCtx = {
      meta: {},
      session: { id: 'sess-f91-reg-policy', append: async () => {} },
    };
    expect(subagentPolicyMode(derivedCtx)).toBe('companions');
    expect(areSubagentsAllowed(derivedCtx)).toBe(false);
    expect(areSubagentCompanionsAllowed(derivedCtx)).toBe(true);
  });

  it('records locked sessionId in lockedSessions during seedSessionSubagentPolicy', () => {
    const seededCtx = {
      meta: {} as Record<string, unknown>,
      messages: [{ role: 'user' as const, content: 'hello' }],
      session: { id: 'sess-f91-reg-seeded', append: async () => {} },
    };
    seedSessionSubagentPolicy(seededCtx);
    expect(
      isSubagentPolicyLocked({
        meta: {},
        session: { id: 'sess-f91-reg-seeded', append: async () => {} },
      }),
    ).toBe(true);
  });
});
