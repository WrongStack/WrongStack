import { describe, expect, it } from 'vitest';
import { redactSecrets } from '../../src/redact.js';

// Use clearly synthetic placeholder tokens that exercise the regex shapes
// without tripping source-level secret scanners. Each CANARY is paired
// with a marker string the regex will recognise as a sensitive flag name.
const TOKEN_VALUE = 'CANARY_TOKEN_VALUE_AAA';
const APIKEY_VALUE = 'CANARY_APIKEY_VALUE_BBB';
const PASSWORD_VALUE = 'CANARY_PWD_VALUE_CCC';
const ENV_VALUE = 'CANARY_ENV_VALUE_DDD';

describe('redactSecrets', () => {
  describe('long flags', () => {
    it('redacts --token=value', () => {
      expect(redactSecrets(`curl --token=${TOKEN_VALUE} https://api.example.com`)).toBe(
        `curl --token=[REDACTED] https://api.example.com`,
      );
    });

    it('redacts --token value (space separator)', () => {
      expect(redactSecrets(`curl --token ${TOKEN_VALUE} https://api.example.com`)).toBe(
        `curl --token [REDACTED] https://api.example.com`,
      );
    });

    it('redacts --api-key=value', () => {
      expect(redactSecrets(`foo --api-key=${APIKEY_VALUE} https://x`)).toBe(
        `foo --api-key=[REDACTED] https://x`,
      );
    });

    it('redacts --password=value', () => {
      expect(redactSecrets(`mysql -u root --password=${PASSWORD_VALUE} db`)).toBe(
        `mysql -u root --password=[REDACTED] db`,
      );
    });

    it('redacts --password value (space separator)', () => {
      expect(redactSecrets(`mysql -u root --password ${PASSWORD_VALUE} db`)).toBe(
        `mysql -u root --password [REDACTED] db`,
      );
    });
  });

  describe('short flags', () => {
    it('redacts -t value', () => {
      const out = redactSecrets(`rsync -t ${TOKEN_VALUE} user@host:/`);
      expect(out).not.toContain(TOKEN_VALUE);
      expect(out).toContain('-t [REDACTED]');
    });

    it('redacts multiple -t flags in the same string', () => {
      const out = redactSecrets(`cmd -t ${TOKEN_VALUE} and -t ${TOKEN_VALUE}`);
      expect(out).toBe('cmd -t [REDACTED] and -t [REDACTED]');
    });

    it('does NOT redact a glued -tVALUE flag (too many false positives)', () => {
      // Glued `-tVALUE` form is intentionally NOT redacted because it
      // collides with common long flags like `-target`, `-tries`,
      // `-timeout`. The test asserts current behavior so a future
      // change is a conscious decision, not a silent regression.
      const input = `rsync -t${TOKEN_VALUE} user@host:/`;
      expect(redactSecrets(input)).toBe(input);
    });

    it('does not redact -t in unrelated words (e.g. -target)', () => {
      const out = redactSecrets('clang -target=x86_64 foo.c');
      expect(out).toBe('clang -target=x86_64 foo.c');
    });
  });

  describe('env-var style secrets', () => {
    it('redacts TOKEN=x', () => {
      expect(redactSecrets(`TOKEN=${ENV_VALUE} node app.js`)).toBe('TOKEN=[REDACTED] node app.js');
    });

    it('redacts API_KEY=value', () => {
      expect(redactSecrets(`API_KEY=${ENV_VALUE} node app.js`)).toBe(
        'API_KEY=[REDACTED] node app.js',
      );
    });

    it('preserves surrounding text', () => {
      expect(redactSecrets(`prefix TOKEN=${ENV_VALUE} suffix`)).toBe(
        'prefix TOKEN=[REDACTED] suffix',
      );
    });
  });

  describe('idempotence', () => {
    it('is a no-op on already-redacted text', () => {
      const once = redactSecrets(`curl --token=${TOKEN_VALUE} https://x`);
      const twice = redactSecrets(once);
      expect(twice).toBe(once);
    });

    it('is a no-op on text with no secrets', () => {
      const input = 'pnpm test --reporter=spec';
      expect(redactSecrets(input)).toBe(input);
    });
  });

  it('fully replaces a sensitive flag that has no separable value', () => {
    expect(redactSecrets('run --token')).toBe('run **redacted**');
  });

  describe('real-world tool output patterns', () => {
    it('redacts a mix of flag-style and env-style secrets in one block', () => {
      const input = [
        `export DATABASE_URL=${ENV_VALUE}`,
        `curl --token=${TOKEN_VALUE} https://api/foo`,
      ].join('\n');
      const out = redactSecrets(input);
      expect(out).not.toContain(TOKEN_VALUE);
      expect(out).not.toContain(ENV_VALUE);
      expect(out).toContain('[REDACTED]');
    });

    it('redacts an inline --api-key on a curl line', () => {
      const out = redactSecrets(`curl --api-key=${APIKEY_VALUE} https://api/foo`);
      expect(out).toContain('api-key=[REDACTED]');
      expect(out).not.toContain(APIKEY_VALUE);
    });
  });
});
