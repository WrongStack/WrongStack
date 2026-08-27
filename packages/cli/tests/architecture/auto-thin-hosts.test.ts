/**
 * Drift test: the CLI boot path that runs `registerBuiltinTools` MUST
 * wire the auto-thinning pipeline passthroughs (event bus, disabledToolMeta,
 * autoThin config) — otherwise the stats-driven disable will silently
 * never trigger. Mirrors `kanban-governance-hosts.test.ts` in style.
 *
 * The runtime `tool-registration.ts` is a passive signature, so its
 * presence is exercised by the TypeScript compiler (a caller that
 * misses an argument fails to build). The CLI host is the one that
 * actually invokes the runtime with concrete values, so it's the one
 * we drift-check here.
 *
 * The test is intentionally file-static so a future change that drops
 * the passthroughs fails the build before merging.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const REQUIRED_PASSTHROUGHS = ['events:', 'disabledToolMeta:', 'autoThin:'];

describe('auto-thin CLI host wires the required passthroughs', () => {
  it('packages/cli/src/boot/tool-registry.ts wires events, disabledToolMeta, and autoThin', async () => {
    const abs = path.resolve(process.cwd(), 'packages/cli/src/boot/tool-registry.ts');
    const text = await fs.readFile(abs, 'utf8');
    for (const needle of REQUIRED_PASSTHROUGHS) {
      expect(text).toContain(needle);
    }
  });
});
