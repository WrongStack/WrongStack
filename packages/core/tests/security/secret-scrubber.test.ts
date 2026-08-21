import { describe, expect, it } from 'vitest';
import { DefaultSecretScrubber } from '../../src/security/secret-scrubber.js';

const s = new DefaultSecretScrubber();

describe('SecretScrubber', () => {
  it('redacts anthropic-style keys', () => {
    const inp = 'token=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGh';
    expect(s.scrub(inp)).toContain('[REDACTED:anthropic_key]');
  });
  it('redacts github PAT', () => {
    const inp = 'ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ';
    expect(s.scrub(inp)).toContain('[REDACTED:github_pat]');
  });
  it('redacts AWS access keys', () => {
    expect(s.scrub('AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED:aws_access_key]');
  });
  it('redacts JWT-like tokens', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(s.scrub(jwt)).toContain('[REDACTED:jwt]');
  });
  it('redacts mongodb URIs', () => {
    expect(s.scrub('mongodb://user:pass@host/db')).toContain('[REDACTED:mongodb_uri]');
  });
  it('redacts high-entropy env-style assignments', () => {
    expect(s.scrub('MY_API_KEY=abcdef1234567890abcdef1234567890')).toContain(
      '[REDACTED:high_entropy_env]',
    );
  });
  it('leaves normal text untouched', () => {
    expect(s.scrub('hello world')).toBe('hello world');
  });
  it('scrubObject recurses', () => {
    const obj = { nested: { token: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz123' } };
    const out = s.scrubObject(obj);
    expect(out.nested.token).toContain('[REDACTED');
  });

  it('scrubs across the 64KB chunk boundary without missing secrets', () => {
    // Inputs larger than SCRUB_CHUNK_BYTES go through the chunked branch.
    // Build a 100KB payload with a secret in each half so we exercise both
    // the early chunk and a chunk after the newline-break boundary.
    const filler = 'x '.repeat(20_000); // ~40 KB
    const newlines = '\n'.repeat(2000); // ~2 KB of newlines for boundary-snap
    const secret1 = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const secret2 = 'ghp_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const blob = `${filler}\n${secret1}\n${newlines}\n${filler}\n${secret2}\n`;
    expect(blob.length).toBeGreaterThan(64 * 1024);
    const scrubbed = s.scrub(blob);
    expect(scrubbed).toContain('[REDACTED:anthropic_key]');
    expect(scrubbed).toContain('[REDACTED:github_pat]');
    expect(scrubbed).not.toContain(secret1);
    expect(scrubbed).not.toContain(secret2);
  });

  it('redacts a secret straddling the 64KB chunk boundary with no nearby newline', () => {
    // The old newline-snap could only break on a newline in the back half of
    // the chunk; a long newline-free line (base64 blob, minified log) cut a
    // secret in half and leaked it. The forward whitespace-snap fixes this.
    const CHUNK = 64 * 1024;
    const secret = `ghp_${'a'.repeat(36)}`; // 40 chars, whitespace-free
    for (const delta of [-20, -5, 0, 5]) {
      // Pad so the secret lands right on the nominal boundary, surrounded by
      // single spaces and otherwise newline-free filler.
      const blob = `${'y'.repeat(CHUNK + delta)} ${secret} ${'z'.repeat(70_000)}`;
      const out = s.scrub(blob);
      expect(out, `delta=${delta}`).not.toContain(secret);
      expect(out, `delta=${delta}`).toContain('[REDACTED:github_pat]');
    }
  });

  it('redacts a multi-line PEM private key straddling the 64KB chunk boundary (SEC-003)', () => {
    // A PEM block is the one multi-line credential pattern. The whitespace
    // snap used to break on a \n INSIDE the key when the 64KB cut landed in
    // the block body, splitting BEGIN from END so neither half matched and
    // both leaked verbatim. The boundary now extends past the closing marker.
    const CHUNK = 64 * 1024;
    const pemLines = ['-----BEGIN RSA PRIVATE KEY-----'];
    for (let i = 0; i < 40; i++) pemLines.push(`MIIEowIBAAKCAQEA${String(i).padStart(3, '0')}ABCDEFGHIJKLMNOPQRSTUVWXYZab`);
    pemLines.push('-----END RSA PRIVATE KEY-----');
    const pem = pemLines.join('\n');
    const pemBodySample = 'MIIEowIBAAKCAQEA000';
    expect(pem.includes('\n')).toBe(true); // genuinely multi-line

    // Control: the same PEM fully inside one chunk is redacted.
    const intact = s.scrub(`x\n${pem}\ny`);
    expect(intact).toContain('[REDACTED:private_key]');
    expect(intact).not.toContain(pemBodySample);

    // Defect case: PEM starts just before the 64KB cut so the old snap broke
    // on a newline inside the block body.
    for (const offset of [100, 500, 2000]) {
      const blob = `${'a'.repeat(CHUNK - offset)}\n${pem}\n${'b'.repeat(70_000)}`;
      const out = s.scrub(blob);
      expect(out, `offset=${offset}`).toContain('[REDACTED:private_key]');
      expect(out, `offset=${offset}`).not.toContain('-----BEGIN RSA PRIVATE KEY-----');
      expect(out, `offset=${offset}`).not.toContain(pemBodySample);
    }
  });

  it('redacts a PEM whose 64KB cut lands inside a BEGIN or END marker line (SEC-003 follow-up)', () => {
    // The boundary helper used to test the private-key marker against the
    // chunk HEAD only. A cut landing inside a marker line leaves a truncated
    // marker in the head: an "-----END" prefix in the head made the helper
    // treat the block as complete (boundary not moved) and the split PEM
    // leaked. The helper now validates the marker against the full text and
    // never shrinks the boundary. Sweep the cut across the entire PEM —
    // body (already covered), BEGIN line, and END line.
    const CHUNK = 64 * 1024;
    const pemLines = ['-----BEGIN EC PRIVATE KEY-----'];
    for (let i = 0; i < 30; i++) pemLines.push(`MHcCAQEEII${String(i).padStart(3, '0')}ABCDEFGHIJKLMNOPQRSTUVabcdefghijklmnopqrstuvwxyz`);
    pemLines.push('-----END EC PRIVATE KEY-----');
    const pem = pemLines.join('\n');
    const bodySample = 'MHcCAQEEII007';

    // Control: intact PEM redacts.
    expect(s.scrub(`x\n${pem}\ny`)).toContain('[REDACTED:private_key]');

    for (let offset = 0; offset <= pem.length; offset += 7) {
      const blob = `${'a'.repeat(CHUNK - offset)}\n${pem}\n${'b'.repeat(70_000)}`;
      const out = s.scrub(blob);
      expect(out, `offset=${offset}`).toContain('[REDACTED:private_key]');
      expect(out, `offset=${offset}`).not.toContain('-----BEGIN EC PRIVATE KEY-----');
      expect(out, `offset=${offset}`).not.toContain('-----END EC PRIVATE KEY-----');
      expect(out, `offset=${offset}`).not.toContain(bodySample);
    }
  });

  it('redacts a PEM whose END marker starts inside the cap but finishes past it (SEC-003 follow-up)', () => {
    // The pre-fix bug lived in one exact window: the guard accepted the block
    // (-----END STARTS before MAX_PEM_BLOCK_BYTES) but the boundary was
    // clamped back to the cap, cutting mid-`-----END`, failing the pattern's
    // END tail and re-leaking the whole key body. Build the fixture with
    // exact byte arithmetic so the END marker starts 10 bytes BEFORE the cap
    // and finishes 19 bytes past it — not a rounded 64-byte-step length,
    // which silently lands in a different window (review finding).
    const CAP = 64 * 1024; // mirrors MAX_PEM_BLOCK_BYTES
    const CHUNK = 64 * 1024;
    const begin = '-----BEGIN RSA PRIVATE KEY-----';
    const end = '-----END RSA PRIVATE KEY-----';
    // prefix = begin + \n + body + \n ; END must start exactly at CAP - 10.
    const joinTarget = CAP - 10 - (begin.length + 1) - 1; // body.join('\n') length
    const bodyLines: string[] = [];
    // 63-char lines join to 64n - 1 bytes; fill with full lines, then one
    // exact-length tail line so the total is precise, not stepped.
    const fullLines = Math.floor((joinTarget + 1) / 64);
    for (let i = 0; i < fullLines; i++) bodyLines.push(`AA${'x'.repeat(60)}${String(i % 10)}`);
    bodyLines.push('B'.repeat(joinTarget - (fullLines * 64 - 1) - 1));
    const pem = `${begin}\n${bodyLines.join('\n')}\n${end}`;
    // The two conditions this fixture exists to hold — asserted, not assumed.
    expect(begin.length + 1 + bodyLines.join('\n').length + 1).toBe(CAP - 10); // END starts inside cap
    expect(CAP - 10 + end.length).toBeGreaterThan(CAP); // …and finishes past it
    const bodySample = bodyLines[500]!.slice(0, 20);

    // Control: intact oversized PEM redacts through the chunked path.
    expect(s.scrub(`x\n${pem}\ny`)).toContain('[REDACTED:private_key]');

    for (let offset = 0; offset <= pem.length; offset += 2048) {
      const blob = `${'a'.repeat(CHUNK - offset)}\n${pem}\n${'b'.repeat(70_000)}`;
      const out = s.scrub(blob);
      expect(out, `offset=${offset}`).toContain('[REDACTED:private_key]');
      expect(out, `offset=${offset}`).not.toContain('-----END RSA PRIVATE KEY-----');
      expect(out, `offset=${offset}`).not.toContain(bodySample);
    }
  });

  it('redacts a high-entropy env secret straddling the chunk boundary', () => {
    const CHUNK = 64 * 1024;
    const v = 'A'.repeat(40);
    const blob = `${'y'.repeat(CHUNK - 10)} MY_API_KEY=${v} ${'z'.repeat(70_000)}`;
    const out = s.scrub(blob);
    expect(out).not.toContain(v);
    expect(out).toContain('[REDACTED:high_entropy_env]');
  });

  it('still redacts a secret after a >1KB whitespace-free run past the boundary', () => {
    // No whitespace within the overlap window → the boundary falls back to the
    // hard cut. A bounded secret can't be in that run (all are whitespace-free
    // and ≤ ~560 chars), and a secret after the cut must still be redacted.
    const CHUNK = 64 * 1024;
    const secret = `ghp_${'b'.repeat(36)}`;
    const blob = `${'y'.repeat(CHUNK + 5000)} ${secret}`;
    const out = s.scrub(blob);
    expect(out).not.toContain(secret);
  });

  it('chunked path keeps total length roughly preserved (no truncation)', () => {
    // A long innocuous text should pass through every chunk and stay intact.
    const blob = 'safe-text\n'.repeat(8000); // ~80 KB
    const out = s.scrub(blob);
    expect(out.length).toBeGreaterThan(70_000);
    expect(out).toContain('safe-text');
  });

  // Adjacency regression: a consuming trailing delimiter used to eat the
  // separator the next match needed, so every other secret leaked. The
  // trailing boundary is now a non-consuming lookahead.
  it('redacts two space-separated high-entropy env secrets (no plaintext leak)', () => {
    const v1 = 'AAAAAAAAAAAAAAAAAAAA';
    const v2 = 'BBBBBBBBBBBBBBBBBBBB';
    const out = s.scrub(`API_KEY=${v1} SESSION_TOKEN=${v2}`);
    expect(out).not.toContain(v1);
    expect(out).not.toContain(v2);
    expect(out).toBe('API_KEY=[REDACTED:high_entropy_env] SESSION_TOKEN=[REDACTED:high_entropy_env]');
  });

  it('redacts newline-separated high-entropy env secrets (printenv/.env dump shape)', () => {
    const v1 = 'AAAAAAAAAAAAAAAAAAAA';
    const v2 = 'BBBBBBBBBBBBBBBBBBBB';
    const v3 = 'CCCCCCCCCCCCCCCCCCCC';
    const out = s.scrub(`API_KEY=${v1}\nSESSION_TOKEN=${v2}\nROOT_PASSWORD=${v3}`);
    expect(out).not.toContain(v1);
    expect(out).not.toContain(v2);
    expect(out).not.toContain(v3);
    expect((out.match(/\[REDACTED:high_entropy_env\]/g) ?? []).length).toBe(3);
    // Newline separators between the redacted lines must be preserved.
    expect(out.split('\n')).toHaveLength(3);
  });

  it('redacts two adjacent Bearer tokens sharing a single delimiter', () => {
    const t1 = 'tokentokentoken1';
    const t2 = 'tokentokentoken2';
    const out = s.scrub(`Bearer ${t1} Bearer ${t2}`);
    expect(out).not.toContain(t1);
    expect(out).not.toContain(t2);
    expect((out.match(/\[REDACTED:bearer_token\]/g) ?? []).length).toBe(2);
  });

  it('still redacts a single high-entropy env secret with surrounding text', () => {
    // Guard against the lookahead over-relaxing the boundary.
    const v = 'abcdef1234567890abcdef';
    const out = s.scrub(`prefix MY_API_KEY=${v} suffix`);
    expect(out).not.toContain(v);
    expect(out).toContain('[REDACTED:high_entropy_env]');
    expect(out).toContain('suffix');
  });

  // AI/ML provider key patterns
  it('redacts HuggingFace tokens', () => {
    // HuggingFace tokens: hf_ followed by exactly 34 alphanumeric chars
    const token = 'hf_abcdefghijklmnopqrstuvwxyz12345678'; // 34 chars after hf_
    expect(token.length).toBe(37); // hf_ (3) + 34 = 37
    const scrubbed = s.scrub(`token: ${token}`);
    expect(scrubbed).toContain('[REDACTED:huggingface_token]');
    expect(scrubbed).not.toContain(token);
  });

  it('redacts Replicate tokens', () => {
    // Replicate tokens: r8_ followed by 40+ alphanumeric chars
    const token = 'r8_abcdefghijklmnopqrstuvwxyz1234567890abcd'; // 40+ chars after r8_
    const scrubbed = s.scrub(`REPLICATE_API_TOKEN=${token}`);
    expect(scrubbed).toContain('[REDACTED:replicate_token]');
    expect(scrubbed).not.toContain(token);
  });

  it('redacts Perplexity API keys', () => {
    // Perplexity keys: pplx- followed by 40+ alphanumeric chars
    const key = 'pplx-abcdefghijklmnopqrstuvwxyz1234567890abcd'; // 40+ chars after pplx-
    const scrubbed = s.scrub(`PERPLEXITY_API_KEY: ${key}`);
    expect(scrubbed).toContain('[REDACTED:perplexity_key]');
    expect(scrubbed).not.toContain(key);
  });

  it('redacts Groq API keys', () => {
    // Groq keys: gsk_ followed by 40+ alphanumeric chars
    const key = 'gsk_abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGH'; // 40+ chars after gsk_
    const scrubbed = s.scrub(`GROQ_API_KEY="${key}"`);
    expect(scrubbed).toContain('[REDACTED:groq_key]');
    expect(scrubbed).not.toContain(key);
  });

  it('does not redact short HuggingFace-like strings', () => {
    // Too short - should not match (needs exactly 34 chars after hf_)
    const short = 'hf_abc123';
    expect(s.scrub(short)).toBe(short);
  });

  it('does not redact short Replicate-like strings', () => {
    // Too short - should not match (needs 40+ chars after r8_)
    const short = 'r8_abc123';
    expect(s.scrub(short)).toBe(short);
  });
  // WS-034: the anchor set that gates every regex pass used to be a separate,
  // hand-maintained list of `text.includes(...)` calls. It had already drifted:
  // `twilio_sid` was in the pattern table but had no anchor, so the pattern
  // could never run — no failing test, no warning, just a silently dead rule.
  // Anchors are now derived from the pattern table and the field is required,
  // so a pattern cannot be added without one.
  describe('anchor derivation (WS-034)', () => {
    it('redacts a Twilio account SID — the pattern the stale anchor list disabled', () => {
      const sid = `AC${'a1b2c3d4'.repeat(4)}`; // AC + 32 hex
      const scrubbed = s.scrub(`sid=${sid}`);
      expect(scrubbed).toContain('[REDACTED:twilio_sid]');
      expect(scrubbed).not.toContain(sid);
    });

    it('still short-circuits text with no credential anchor at all', () => {
      const clean = 'ordinary tool output: 42 files changed, 3 insertions(+)';
      expect(s.scrub(clean)).toBe(clean);
    });

    it('keeps redacting every previously-anchored family', () => {
      const cases: Array<[string, string]> = [
        [`ghp_${'a'.repeat(36)}`, 'github_pat'],
        [`AKIA${'A'.repeat(16)}`, 'aws_access_key'],
        [`AIza${'a'.repeat(35)}`, 'gcp_key'],
        [`hf_${'a'.repeat(34)}`, 'huggingface_token'],
        [`gsk_${'a'.repeat(44)}`, 'groq_key'],
        [`pplx-${'a'.repeat(44)}`, 'perplexity_key'],
        [`r8_${'a'.repeat(44)}`, 'replicate_token'],
      ];
      for (const [secret, type] of cases) {
        const scrubbed = s.scrub(`value=${secret}`);
        expect(scrubbed, `${type} should be redacted`).toContain(`[REDACTED:${type}]`);
        expect(scrubbed).not.toContain(secret);
      }
    });
  });
  // WS-034: the plugin runtime carried 37 credential patterns while this
  // scrubber — which guards session JSONL, chronicle, HQ broadcast, WebUI
  // events and the auth audit — carried 22. The plugin side already had a
  // parity test; it simply did not cover core. `gho_` matters most: WrongStack
  // mints those itself in the Copilot OAuth flow.
  describe('parity with the plugin credential table (WS-034)', () => {
    it.each([
      [`gho_${'a'.repeat(36)}`, 'github_oauth_token'],
      [`ghu_${'a'.repeat(36)}`, 'github_oauth_token'],
      [`glpat-${'a'.repeat(24)}`, 'gitlab_pat'],
      [`glrt-${'a'.repeat(24)}`, 'gitlab_runner_token'],
      [`npm_${'a'.repeat(36)}`, 'npm_token'],
      [`xapp-1-${'A'.repeat(16)}`, 'slack_app_token'],
      [`SG.${'a'.repeat(22)}.${'b'.repeat(22)}`, 'sendgrid_key'],
      [`dop_v1_${'a'.repeat(64)}`, 'digitalocean_token'],
      [`dp.pt.${'a'.repeat(44)}`, 'doppler_token'],
      [`shpat_${'a'.repeat(32)}`, 'shopify_token'],
      [`dckr_pat_${'a'.repeat(24)}`, 'docker_pat'],
      [`lin_api_${'a'.repeat(44)}`, 'linear_key'],
      [`ATATT3${'a'.repeat(44)}`, 'atlassian_token'],
      [`GOCSPX-${'a'.repeat(24)}`, 'google_oauth_client_secret'],
    ])('redacts %s as %s', (secret, type) => {
      const scrubbed = s.scrub(`value=${secret}`);
      expect(scrubbed).toContain(`[REDACTED:${type}]`);
      expect(scrubbed).not.toContain(secret);
    });

    it('redacts a Slack incoming-webhook URL', () => {
      const url = `https://hooks.slack.com/services/T${'A'.repeat(8)}/B${'B'.repeat(8)}/${'c'.repeat(24)}`;
      const scrubbed = s.scrub(`posting to ${url}`);
      expect(scrubbed).toContain('[REDACTED:slack_webhook]');
      expect(scrubbed).not.toContain(url);
    });
  });

  describe('JSON-serialised credentials', () => {
    // Attacker goal: get a credential into the session JSONL, the chronicle,
    // an HQ broadcast, or the model's own context by having it appear as a
    // JSON value rather than a prefixed literal.
    //
    // This class was previously undetectable. `JSON_KEY_ANCHORS` listed the key
    // names, but no pattern consumed them — the anchors only told the pre-scan
    // to keep going, every regex then declined, and the value was emitted
    // verbatim. `high_entropy_env` cannot cover it: it requires an uppercase
    // UNQUOTED key, so `{"apiKey":"…"}` never matched.
    const secret = 'abcdef0123456789abcdef0123456789';

    it.each([
      ['camelCase key', `{"apiKey":"${secret}"}`],
      ['snake_case key', `{"access_token":"${secret}"}`],
      ['prefixed key', `{"anthropicApiKey": "${secret}"}`],
      ['whitespace around the colon', `{"token" : "${secret}"}`],
      ['client_secret', `{"client_secret":"${secret}"}`],
    ])('redacts a credential behind a %s', (_label, payload) => {
      const scrubbed = s.scrub(payload);
      expect(scrubbed).toContain('[REDACTED:json_credential_key]');
      expect(scrubbed).not.toContain(secret);
    });

    it('preserves the key and the quotes so the output is still valid JSON', () => {
      const scrubbed = s.scrub(`{"apiKey":"${secret}"}`);
      expect(scrubbed).toBe('{"apiKey":"[REDACTED:json_credential_key]"}');
      expect(() => JSON.parse(scrubbed)).not.toThrow();
    });

    it.each([
      ['a numeric token counter', '{"tokenCount": 1234, "maxTokens": 8000}'],
      ['a short enum value', '{"authorization":"none"}'],
      ['prose that merely mentions a token', 'the token was rotated yesterday'],
      ['ordinary package metadata', '{"name":"wrongstack","version":"0.306.3"}'],
    ])('leaves %s untouched', (_label, payload) => {
      expect(s.scrub(payload)).toBe(payload);
    });
  });
});
