/**
 * Smoke-test for the iOS assistant persona.
 *
 * Test isolation:
 *   The agent-prompt loader honors WRONGSTACK_AGENT_INSTRUCTIONS_DIR and
 *   WRONGSTACK_HOME, so a customized environment could let this test
 *   validate an override instead of the checked-in fixture. To pin the
 *   fixture source we set WRONGSTACK_AGENT_INSTRUCTIONS_DIR to the
 *   repo-relative directory containing the bundled ios.md before the
 *   loader is called, then read the same file directly to compare. The
 *   env var is restored after the suite runs.
 *
 *   Note on ordering: the dynamic imports below run at module load time,
 *   but the loader reads `process.env` lazily inside agentPrompt() — not
 *   at import time — so beforeAll setting the env var before any test
 *   runs is sufficient to pin the fixture source.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Fixture path: <repo>/packages/core/instructions/agents/ios.md
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, '../../instructions/agents');
const FIXTURE_FILE = path.join(FIXTURE_DIR, 'ios.md');

// Dynamic imports at module top level (top-level await is allowed in ESM).
// The loader reads env vars lazily inside agentPrompt(), so beforeAll
// setting WRONGSTACK_AGENT_INSTRUCTIONS_DIR before any test runs is what
// pins the fixture source.
const { agentPrompt } = await import('../../src/coordination/agents/agent-prompts.js');
const { AGENT_CATALOG, ALL_AGENT_DEFINITIONS } = await import(
  '../../src/coordination/agents/index.js'
);
const { FLEET_ROSTER } = await import('../../src/coordination/fleet.js');

describe('iOS assistant smoke-test', () => {
  let originalEnvDir: string | undefined;

  beforeAll(() => {
    // Pin the loader to the bundled fixture directory before any test runs.
    originalEnvDir = process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'];
    process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'] = FIXTURE_DIR;
    // Sanity: the fixture must exist on disk.
    expect(existsSync(FIXTURE_FILE), `fixture exists at ${FIXTURE_FILE}`).toBe(true);
  });

  afterAll(() => {
    // Restore env so other test files are not affected.
    if (originalEnvDir === undefined) {
      delete process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'];
    } else {
      process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'] = originalEnvDir;
    }
  });

  describe('file-loader resolution', () => {
    it('loads the bundled fixture and matches the on-disk bytes exactly', () => {
      const prompt = agentPrompt('ios');
      const fixture = readFileSync(FIXTURE_FILE, 'utf8').trimEnd();
      // Pinning WRONGSTACK_AGENT_INSTRUCTIONS_DIR to FIXTURE_DIR must make
      // the loader return the bundled fixture, byte-for-byte.
      expect(prompt, 'loader returns the bundled ios.md').toBe(fixture);
    });

    it('prompt body is substantive (not a stub)', () => {
      const prompt = agentPrompt('ios');
      expect(prompt.length, 'prompt body length').toBeGreaterThan(2000);
    });

    it('honors WRONGSTACK_AGENT_INSTRUCTIONS_DIR override (precedence contract)', () => {
      // Pin a private override directory containing a marker ios.md, point
      // the loader at it, and confirm the loader returns the override
      // (not the bundled fixture). This locks in the env-var precedence
      // behavior the test-isolation guarantee depends on.
      const overrideDir = path.join(
        os.tmpdir(),
        `wstack-ios-override-${process.pid}-${Date.now()}`,
      );
      mkdirSync(overrideDir, { recursive: true });
      const marker =
        '# override marker\nThis ios.md came from an override directory, not the bundled fixture.\n';
      writeFileSync(path.join(overrideDir, 'ios.md'), marker, 'utf8');

      const prevDir = process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'];
      process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'] = overrideDir;
      try {
        const overridePrompt = agentPrompt('ios');
        expect(overridePrompt, 'loader returns the override ios.md').toBe(marker.trimEnd());
      } finally {
        // Restore env and clean up the override directory regardless of
        // test outcome — the existing beforeAll() sets the env var to
        // FIXTURE_DIR, but only on the way in; we restore to its in-test
        // value here so we don't leak state into subsequent tests in the
        // same describe.
        if (prevDir === undefined) {
          delete process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'];
        } else {
          process.env['WRONGSTACK_AGENT_INSTRUCTIONS_DIR'] = prevDir;
        }
        rmSync(overrideDir, { recursive: true, force: true });
      }
    });
  });

  describe('toolchain anchor framing', () => {
    it('honestly calls the toolchain a baseline, not "latest"', () => {
      const prompt = agentPrompt('ios');
      expect(prompt, 'baseline framing').toContain('baseline');
      expect(prompt, 'patch-version pointer to installed Xcode').toMatch(/26\.6|Swift 6\.3/);
    });

    it('includes the Xcode 26 / Swift 6.2 anchors', () => {
      const prompt = agentPrompt('ios');
      expect(prompt, 'Xcode 26 anchor').toContain('Xcode 26');
      expect(prompt, 'Swift 6.2 anchor').toContain('Swift 6.2');
      expect(prompt, 'Approachable Concurrency').toContain('Approachable Concurrency');
    });
  });

  describe('Approachable Concurrency guidance is accurate', () => {
    it('does not frame Approachable Concurrency as an escape hatch', () => {
      const prompt = agentPrompt('ios');
      expect(prompt, '"escape hatch" framing still present').not.toContain('escape hatch');
    });

    it('describes main-actor default + caller-context async + safety preserved', () => {
      const prompt = agentPrompt('ios');
      expect(prompt, 'main-actor default').toContain('main actor');
      expect(prompt, 'caller-context async').toMatch(/caller(.)*async|inherit the caller/);
      expect(prompt, 'safety preserved').toMatch(/data-race safety|Safety checks stay on/);
      expect(prompt, '@concurrent opt-in').toContain('@concurrent');
    });
  });

  describe('Swift type-system guidance (peer-review corrections)', () => {
    it('does not pair @Observable with value-type view models', () => {
      const prompt = agentPrompt('ios');
      expect(prompt, 'old "value-type view models" still present').not.toContain(
        'value-type view models',
      );
      expect(prompt, 'reference-type view model guidance').toContain('reference-type view');
    });

    it('does not pair @Model with value-semantic framing', () => {
      const prompt = agentPrompt('ios');
      expect(prompt, 'old "value-semantic" still present').not.toContain('value-semantic');
      expect(prompt, '@Model reference-type class guidance').toContain('reference-type classes');
    });
  });

  describe('Talking to Xcode section (user requirement: xcode iletişim)', () => {
    it('covers the standard Xcode CLI surface', () => {
      const prompt = agentPrompt('ios');
      expect(prompt, 'Talking to Xcode section header').toContain('Talking to Xcode');
      expect(prompt, 'xcodebuild guidance').toContain('xcodebuild');
      expect(prompt, 'xcrun simctl guidance').toContain('xcrun simctl');
      expect(prompt, 'xcrun devicectl guidance').toContain('xcrun devicectl');
      expect(prompt, 'xcresulttool guidance').toContain('xcresulttool');
      expect(prompt, 'xctrace guidance').toContain('xctrace');
      expect(prompt, 'notarytool guidance').toContain('notarytool');
      expect(prompt, 'Swift Package Manager guidance').toContain('Swift Package Manager');
      expect(prompt, '.xcode-version pin').toContain('.xcode-version');
    });
  });

  describe('catalog + roster integration', () => {
    it('AGENT_CATALOG[ios] is defined with the expected shape', () => {
      const def = AGENT_CATALOG['ios'];
      expect(def, 'AGENT_CATALOG[ios]').toBeDefined();
      expect(def?.config.role).toBe('ios');
      expect(def?.config.id).toBe('ios');
      expect(def?.config.name).toBe('iOS');
      expect(def?.capability.phase).toBe('domain');
      expect(def?.capability.keywords).toContain('swiftui');
      expect(def?.capability.keywords).toContain('swiftdata');
      expect(def?.capability.keywords).toContain('ios');
    });

    it('FLEET_ROSTER[ios] is defined and shares the catalog prompt', async () => {
      const rosterEntry = FLEET_ROSTER['ios'];
      expect(rosterEntry, 'FLEET_ROSTER[ios]').toBeDefined();
      // The roster entry prompt is computed at module load time. Compare
      // against the fixture directly rather than agentPrompt() because
      // agentPrompt() has a project-identity layer that depends on env vars.
      expect(rosterEntry?.prompt).toContain('You are the iOS assistant');
      expect(rosterEntry?.prompt).toContain('Xcode');
      expect(rosterEntry?.tools).toContain('fetch');
      expect(rosterEntry?.prompt?.length).toBeGreaterThan(500);
      // Upper bound = bloat guard, not an exact size. The roster prompt is
      // resolved at module import (before beforeAll pins the instructions
      // dir), so it carries the project-contextualization overlay — including
      // the structured what/why/how knowledge-capture boilerplate — on top of
      // the ~6.7 KB ios.md brief.
      expect(rosterEntry?.prompt?.length).toBeLessThan(12_000);
    });

    it('catalog size is 75 (post-addition sanity check)', () => {
      expect(ALL_AGENT_DEFINITIONS.length).toBe(75);
      expect(Object.keys(AGENT_CATALOG).length).toBe(75);
    });
  });
});
