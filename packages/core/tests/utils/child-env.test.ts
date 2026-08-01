/**
 * Tests for child-env — sanitized child-process environment builder.
 * Covers secret-name filter, value-side credential detection,
 * NODE_OPTIONS sanitization, and passthrough mode.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildChildEnv,
  configureChildEnvGitIdentity,
  getChildEnvGitIdentity,
  sanitizeNodeOptions,
} from '../../src/utils/child-env.js';

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

// ============================================================================
// sanitizeNodeOptions
// ============================================================================

describe('sanitizeNodeOptions', () => {
  it('should return empty string for empty input', () => {
    expect(sanitizeNodeOptions('')).toBe('');
  });

  it('should preserve benign flags', () => {
    expect(sanitizeNodeOptions('--no-warnings')).toBe('--no-warnings');
    expect(sanitizeNodeOptions('--max-old-space-size=4096')).toBe('--max-old-space-size=4096');
  });

  it('should strip --require with equals', () => {
    expect(sanitizeNodeOptions('--require=exploit.js')).toBe('');
  });

  it('should strip --import with equals', () => {
    expect(sanitizeNodeOptions('--import=inject.mjs')).toBe('');
  });

  it('should strip --loader with equals', () => {
    expect(sanitizeNodeOptions('--loader=hack.mjs')).toBe('');
  });

  it('should strip --require and following token space-separated', () => {
    expect(sanitizeNodeOptions('--require exploit.js')).toBe('');
  });

  it('should preserve benign flags and strip injection flags', () => {
    const result = sanitizeNodeOptions('--no-warnings --require=x.js --max-old-space-size=2048');
    expect(result).toBe('--no-warnings --max-old-space-size=2048');
  });
});

// ============================================================================
// buildChildEnv
// ============================================================================

describe('buildChildEnv', () => {
  it('should forward allowed system vars', () => {
    process.env = { PATH: '/usr/bin', HOME: '/home/user' };
    const result = buildChildEnv();
    expect(result.PATH).toBe('/usr/bin');
    expect(result.HOME).toBe('/home/user');
  });

  it('should strip vars with TOKEN in the name', () => {
    process.env = { PATH: '/usr/bin', MY_TOKEN: 'abc123' };
    const result = buildChildEnv();
    expect(result.PATH).toBe('/usr/bin');
    expect(result.MY_TOKEN).toBeUndefined();
  });

  it('should strip vars with SECRET in the name', () => {
    process.env = { MY_SECRET: 'sensitive' };
    const result = buildChildEnv();
    expect(result.MY_SECRET).toBeUndefined();
  });

  it('should strip vars with PASSWORD in the name', () => {
    process.env = { DB_PASSWORD: 'xxx' };
    const result = buildChildEnv();
    expect(result.DB_PASSWORD).toBeUndefined();
  });

  it('should strip vars with KEY in the name', () => {
    process.env = { API_KEY: 'sk-xxx' };
    const result = buildChildEnv();
    expect(result.API_KEY).toBeUndefined();
  });

  it('should forward WRONGSTACK_ prefixed vars', () => {
    process.env = { WRONGSTACK_HOME: '/custom/home', WRONGSTACK_SESSION_ID: 'sess_abc' };
    const result = buildChildEnv();
    expect(result.WRONGSTACK_HOME).toBe('/custom/home');
  });

  // WS-033: the vault KEK matched no SECRET_NAME_PARTS entry, so it fell through
  // to the WRONGSTACK_ prefix allow-rule above and was handed to every child
  // process — including the agent's own exec/bash tools and MCP stdio servers.
  it('should strip WRONGSTACK_VAULT_PASSPHRASE despite the WRONGSTACK_ prefix', () => {
    process.env = { WRONGSTACK_VAULT_PASSPHRASE: 'kek-secret', WRONGSTACK_HOME: '/h' };
    const result = buildChildEnv();
    expect(result.WRONGSTACK_VAULT_PASSPHRASE).toBeUndefined();
    expect(result.WRONGSTACK_HOME).toBe('/h');
  });

  it('should strip any PASSPHRASE-bearing var', () => {
    process.env = { PATH: '/usr/bin', GPG_PASSPHRASE: 'p', SSH_KEY_PASSPHRASE: 'q' };
    const result = buildChildEnv();
    expect(result.GPG_PASSPHRASE).toBeUndefined();
    expect(result.SSH_KEY_PASSPHRASE).toBeUndefined();
  });

  it('should forward NODE_ prefixed vars', () => {
    process.env = { NODE_ENV: 'test' };
    const result = buildChildEnv();
    expect(result.NODE_ENV).toBe('test');
  });

  it('should forward CI vars', () => {
    process.env = { CI: 'true' };
    const result = buildChildEnv();
    expect(result.CI).toBe('true');
  });

  it('should forward EDITOR var', () => {
    process.env = { EDITOR: 'vim' };
    const result = buildChildEnv();
    expect(result.EDITOR).toBe('vim');
  });

  it('should strip value with embedded credential', () => {
    process.env = { DB_URL: 'scheme://user:secret@host' };
    const result = buildChildEnv();
    expect(result.DB_URL).toBeUndefined();
  });

  it('should sanitize NODE_OPTIONS', () => {
    process.env = { NODE_OPTIONS: '--require=x.js --no-warnings' };
    const result = buildChildEnv();
    expect(result.NODE_OPTIONS).toBe('--no-warnings');
  });

  it('should inject session ID', () => {
    process.env = { PATH: '/usr/bin' };
    const result = buildChildEnv({ sessionId: 'sess_test123' });
    expect(result.WRONGSTACK_SESSION_ID).toBe('sess_test123');
  });

  it('should merge extra vars', () => {
    process.env = { PATH: '/usr/bin' };
    const result = buildChildEnv({ extra: { CUSTOM_VAR: 'value123' } });
    expect(result.CUSTOM_VAR).toBe('value123');
  });

  it('should accept string alias as sessionId', () => {
    process.env = { PATH: '/usr/bin' };
    const result = buildChildEnv('sess_shorthand');
    expect(result.WRONGSTACK_SESSION_ID).toBe('sess_shorthand');
  });

  it('should handle boolean sessionId opts', () => {
    process.env = { PATH: '/usr/bin' };
    const result = buildChildEnv({});
    expect(result.PATH).toBe('/usr/bin');
  });

  it('should detect SESSION vars as secrets', () => {
    process.env = { TEST_SESSION: 'cookie-value' };
    const result = buildChildEnv();
    expect(result.TEST_SESSION).toBeUndefined();
  });

  it('should forward SESSION_ID vars', () => {
    process.env = { WRONGSTACK_SESSION_ID: 'sess_abc' };
    const result = buildChildEnv();
    expect(result.WRONGSTACK_SESSION_ID).toBe('sess_abc');
  });

  it('should strip NODE_ENV when WRONGSTACK_NODE_ENV_DEFAULTED is set', () => {
    process.env = { WRONGSTACK_NODE_ENV_DEFAULTED: '1', NODE_ENV: 'production', PATH: '/usr/bin' };
    const result = buildChildEnv();
    expect(result.NODE_ENV).toBeUndefined();
    expect(result.WRONGSTACK_NODE_ENV_DEFAULTED).toBeUndefined();
  });

  it('should forward NODE_ENV when not defaulted', () => {
    process.env = { NODE_ENV: 'test', PATH: '/usr/bin' };
    const result = buildChildEnv();
    expect(result.NODE_ENV).toBe('test');
  });
});

// ============================================================================
// git identity injection
// ============================================================================

describe('configureChildEnvGitIdentity', () => {
  afterEach(() => {
    configureChildEnvGitIdentity(null);
  });

  it('injects all four GIT_* vars when name and email are set', () => {
    process.env = { PATH: '/usr/bin' };
    configureChildEnvGitIdentity({ name: 'Alt Name', email: 'alt@example.com' });
    const result = buildChildEnv();
    expect(result.GIT_AUTHOR_NAME).toBe('Alt Name');
    expect(result.GIT_COMMITTER_NAME).toBe('Alt Name');
    expect(result.GIT_AUTHOR_EMAIL).toBe('alt@example.com');
    expect(result.GIT_COMMITTER_EMAIL).toBe('alt@example.com');
  });

  it('injects only email vars when name is unset', () => {
    process.env = { PATH: '/usr/bin' };
    configureChildEnvGitIdentity({ email: 'alt@example.com' });
    const result = buildChildEnv();
    expect(result.GIT_AUTHOR_NAME).toBeUndefined();
    expect(result.GIT_COMMITTER_NAME).toBeUndefined();
    expect(result.GIT_AUTHOR_EMAIL).toBe('alt@example.com');
    expect(result.GIT_COMMITTER_EMAIL).toBe('alt@example.com');
  });

  it('injects nothing when cleared with null', () => {
    process.env = { PATH: '/usr/bin' };
    configureChildEnvGitIdentity({ name: 'Alt', email: 'alt@example.com' });
    configureChildEnvGitIdentity(null);
    const result = buildChildEnv();
    expect(result.GIT_AUTHOR_NAME).toBeUndefined();
    expect(result.GIT_AUTHOR_EMAIL).toBeUndefined();
  });

  it('treats whitespace-only values as unset', () => {
    configureChildEnvGitIdentity({ name: '  ', email: '' });
    expect(getChildEnvGitIdentity()).toBeNull();
  });

  it('overrides an inherited GIT_AUTHOR_* from the parent env', () => {
    process.env = { PATH: '/usr/bin', GIT_AUTHOR_NAME: 'Parent Name' };
    configureChildEnvGitIdentity({ name: 'Configured Name' });
    const result = buildChildEnv();
    expect(result.GIT_AUTHOR_NAME).toBe('Configured Name');
  });

  it('lets an explicit extra override the configured identity', () => {
    process.env = { PATH: '/usr/bin' };
    configureChildEnvGitIdentity({ name: 'Configured Name' });
    const result = buildChildEnv({ extra: { GIT_AUTHOR_NAME: 'Caller Name' } });
    expect(result.GIT_AUTHOR_NAME).toBe('Caller Name');
  });

  it('getChildEnvGitIdentity returns the trimmed configured identity', () => {
    configureChildEnvGitIdentity({ name: ' Alt Name ', email: ' alt@example.com ' });
    expect(getChildEnvGitIdentity()).toEqual({ name: 'Alt Name', email: 'alt@example.com' });
  });
});
