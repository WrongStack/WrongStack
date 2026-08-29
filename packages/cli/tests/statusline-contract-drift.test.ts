import { describe, expect, it } from 'vitest';
import { DEFAULT_LINES, STATUSLINE_ITEMS } from '@wrongstack/core/statusline';
import { STATUSLINE_CONFIG_KEYS } from '../src/services/statusline-config.js';

/**
 * Drift guard for the statusline chip contract: the framework-free core
 * contract (`@wrongstack/core/statusline`) and the CLI persistence
 * vocabulary (`STATUSLINE_CONFIG_KEYS` in statusline-config.ts) are two
 * lists describing the same chip set. They must stay set-equal and complete
 * — a chip that exists in one but not the other silently loses either its
 * persistence toggle or its default line assignment.
 */
describe('statusline contract drift guard', () => {
  it('keeps the core contract key set set-equal with the CLI config keys', () => {
    expect([...STATUSLINE_ITEMS].sort()).toEqual([...STATUSLINE_CONFIG_KEYS].sort());
  });

  it('assigns a default line to every persisted config key', () => {
    expect(Object.keys(DEFAULT_LINES).sort()).toEqual([...STATUSLINE_CONFIG_KEYS].sort());
  });
});
