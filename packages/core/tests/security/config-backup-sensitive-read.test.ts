/**
 * F1 (SECRETS-002): `config.json.last` and `config.json.<ts>.bak` are
 * verbatim copies of the live config (secrets included) written by
 * `config-history` — the writer's own comment says so. The previous
 * `$`-anchored `AGENT_STATE_SENSITIVE_BASENAMES` regex missed them, so a
 * prompt-injected read of `config.json.last` was auto-approved while the
 * identical `config.json` would have prompted. Chains with the H-7
 * Windows vault-key read to complete credential recovery.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSensitiveReadCall } from '../../src/security/permission-helpers.js';
import type { Tool } from '../../src/types/tool.js';

const readTool: Tool = {
  name: 'read',
  description: '',
  inputSchema: { type: 'object', properties: {} },
  capabilities: [],
  async execute() {
    return '';
  },
} as unknown as Tool;

// `isSensitiveReadCall` checks path containment against
// `wstackGlobalRoot()` (`~/.wrongstack`). In test, the vitest setup pins
// `WRONGSTACK_HOME` to a temp dir, so we resolve the agent-state root
// from that same env var the production code uses.
const stateRoot = process.env['WRONGSTACK_HOME']
  ? path.resolve(process.env['WRONGSTACK_HOME'])
  : path.join(os.homedir(), '.wrongstack');
const inState = (basename: string): string => path.join(stateRoot, basename);

describe('isSensitiveReadCall — F1 config-backup coverage', () => {
  it.each([
    ['config.json'],
    ['config.local.json'],
    ['trust.json'],
    ['auth.json'],
    ['.key'],
  ])('still flags live config basenames: %s', (basename) => {
    expect(isSensitiveReadCall(readTool, { path: inState(basename) })).toBe(true);
  });

  it.each([
    // The exact writer outputs (config-history.ts:344-385)
    ['config.json.last'],
    ['config.json.2024-01-15T10-30-00.bak'],
    // A user-created manual backup with arbitrary extension
    ['config.json.backup'],
    ['config.local.json.manual-snapshot'],
  ])('now flags backup/snapshot copies: %s', (basename) => {
    expect(isSensitiveReadCall(readTool, { path: inState(basename) })).toBe(true);
  });

  it('does NOT flag unrelated files in the same dir', () => {
    expect(isSensitiveReadCall(readTool, { path: inState('memory.md') })).toBe(false);
    expect(isSensitiveReadCall(readTool, { path: inState('sessions/abc.json') })).toBe(false);
    // `config.jsonc` is not one of the protected basenames — the
    // sensitive-read prompt must not be triggered for it.
    expect(isSensitiveReadCall(readTool, { path: inState('config.jsonc') })).toBe(false);
  });
});
