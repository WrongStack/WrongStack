import { describe, expect, it } from 'vitest';
import {
  BENCH_RUN_BOOLEAN_FLAG_NAMES,
  BENCH_RUN_FLAGS,
  BENCH_RUN_VALUE_FLAG_NAMES,
  buildBenchRunUsageLine,
  renderBenchRunHelpToString,
} from '../src/subcommands/handlers/bench-run-help.js';
import { renderDeepHelpToString } from '../src/subcommands/handlers/per-subcommand-help.js';

/**
 * The `bench-run-help.ts` module is the single source of truth
 * for the `wstack bench run` flag list. The `BENCH_RUN_FLAGS`
 * array drives:
 *
 *   - The help block rendered by `renderBenchRunHelpToString()`
 *     (and the `bench:run` deep entry's `customBody` field)
 *   - The `BENCH_RUN_BOOLEAN_FLAG_NAMES` / `BENCH_RUN_VALUE_FLAG_NAMES`
 *     constants the parser's helpers use to look up defaults
 *     and required checks
 *   - The `Usage:` line written to stderr (via
 *     `buildBenchRunUsageLine()`)
 *
 * The tests below pin the contract for all of these.
 */
describe('bench-run-help', () => {
  describe('BENCH_RUN_FLAGS (the source of truth)', () => {
    it('contains 14 flags: 7 suite + 2 models + 5 control', () => {
      expect(BENCH_RUN_FLAGS).toHaveLength(14);
      const suite = BENCH_RUN_FLAGS.filter((f) => f.group === 'suite');
      const models = BENCH_RUN_FLAGS.filter((f) => f.group === 'models');
      const control = BENCH_RUN_FLAGS.filter((f) => f.group === 'control');
      expect(suite).toHaveLength(7);
      expect(models).toHaveLength(2);
      expect(control).toHaveLength(5);
    });

    it('each entry has a non-empty name, flag, description, group, and kind', () => {
      for (const f of BENCH_RUN_FLAGS) {
        expect(f.name).toMatch(/^[a-z][a-z0-9-]*$/);
        expect(f.flag).toMatch(/^--/);
        expect(f.description.length).toBeGreaterThan(10);
        expect(['suite', 'models', 'control']).toContain(f.group);
        expect(['boolean', 'value']).toContain(f.kind);
      }
    });

    it('boolean flags are the suite docker toggle and the sandbox-retention switch', () => {
      expect(BENCH_RUN_BOOLEAN_FLAG_NAMES).toEqual(['docker', 'keep-sandbox']);
    });

    it('value flags include the required polyglot-dir and the optional languages / dataset-dir', () => {
      const names = BENCH_RUN_VALUE_FLAG_NAMES;
      expect(names).toContain('suite');
      expect(names).toContain('polyglot-dir');
      expect(names).toContain('languages');
      expect(names).toContain('dataset-dir');
      expect(names).toContain('models');
      expect(names).toContain('cell');
      expect(names).toContain('suite-dir');
      expect(names).toContain('manifest');
      expect(names).toContain('limit');
      expect(names).toContain('out');
      expect(names).toContain('concurrency');
      expect(names).toContain('repeats');
      expect(names).toHaveLength(12);
    });

    it('every flag has a unique name (no duplicates)', () => {
      const names = BENCH_RUN_FLAGS.map((f) => f.name);
      expect(new Set(names).size).toBe(names.length);
    });

    it('the polyglot-dir flag is not globally required (only when --suite polyglot)', () => {
      const polyglotDir = BENCH_RUN_FLAGS.find((f) => f.name === 'polyglot-dir');
      expect(polyglotDir?.required).toBeUndefined();
    });

    it('the suite / models / out flags have default values', () => {
      const suite = BENCH_RUN_FLAGS.find((f) => f.name === 'suite');
      const models = BENCH_RUN_FLAGS.find((f) => f.name === 'models');
      const out = BENCH_RUN_FLAGS.find((f) => f.name === 'out');
      expect(suite?.defaultValue).toBe('core');
      expect(models?.defaultValue).toBe('bench.config.json');
      expect(out?.defaultValue).toBe('bench-results');
    });
  });

  describe('renderBenchRunHelpToString (the help block)', () => {
    const block = renderBenchRunHelpToString();

    it('starts with the bold title line', () => {
      const firstLine = block.split('\n')[0];
      expect(firstLine).toContain('wstack bench run');
    });

    it('contains every flag name in the flag list', () => {
      for (const f of BENCH_RUN_FLAGS) {
        expect(block).toContain(f.flag);
      }
    });

    it('groups the flags with Suite selection / Model matrix / Run control subheaders', () => {
      expect(block).toContain('Suite selection:');
      expect(block).toContain('Model matrix:');
      expect(block).toContain('Run control:');
    });

    it('orders the groups in the expected sequence', () => {
      const suiteIdx = block.indexOf('Suite selection:');
      const modelsIdx = block.indexOf('Model matrix:');
      const controlIdx = block.indexOf('Run control:');
      expect(suiteIdx).toBeGreaterThan(-1);
      expect(modelsIdx).toBeGreaterThan(suiteIdx);
      expect(controlIdx).toBeGreaterThan(modelsIdx);
    });

    it('does not mark polyglot-dir as globally required', () => {
      const polyglotDirLine = block
        .split('\n')
        .find((l) => l.includes('--polyglot-dir') && l.includes('Aider polyglot dataset'));
      expect(polyglotDirLine).toBeDefined();
      expect(polyglotDirLine).not.toContain('(required)');
    });

    it('annotates the suite / models / out flags with their default values', () => {
      expect(block).toContain('(default: core)');
      expect(block).toContain('(default: bench.config.json)');
      expect(block).toContain('(default: bench-results)');
    });

    it('includes a "See also:" line pointing at bench list / report / compare', () => {
      expect(block).toContain('See also:');
      expect(block).toContain('wstack bench list');
      expect(block).toContain('wstack bench report');
      expect(block).toContain('wstack bench compare');
    });

    it('ends with a trailing newline (matches the auth-local-help convention)', () => {
      expect(block.endsWith('\n')).toBe(true);
    });
  });

  describe('byte-for-byte parity with the bench:run deep entry (single source of truth)', () => {
    it('renderDeepHelpToString("bench:run") === renderBenchRunHelpToString()', () => {
      // The deep entry's `customBody` is `renderBenchRunHelpToString`.
      // `renderDeepHelpToString` calls `customBody` and returns its
      // output verbatim. The two outputs MUST be byte-for-byte
      // identical — that's the entire point of the delegation.
      const fromDeep = renderDeepHelpToString('bench:run');
      const fromHelp = renderBenchRunHelpToString();
      expect(fromDeep).toBe(fromHelp);
    });

    it('the deep entry does NOT render the standard Tip footer (customBody owns the layout)', () => {
      const fromDeep = renderDeepHelpToString('bench:run');
      expect(fromDeep).not.toContain('Tip: `wstack --help` lists every top-level command.');
    });
  });

  describe('buildBenchRunUsageLine (the parser fallback)', () => {
    it('starts with `wstack bench run`', () => {
      expect(buildBenchRunUsageLine().startsWith('wstack bench run')).toBe(true);
    });

    it('includes every flag from the source-of-truth list', () => {
      const line = buildBenchRunUsageLine();
      for (const f of BENCH_RUN_FLAGS) {
        expect(line).toContain(f.flag);
      }
    });

    it('produces a single line (no embedded newlines)', () => {
      expect(buildBenchRunUsageLine().includes('\n')).toBe(false);
    });
  });

  describe('the standard layout does NOT include bench:run (it has customBody)', () => {
    it('the deep entry is in deepHelpTable, not helpTable', async () => {
      // Lazy import: per-subcommand-help is large.
      const mod = await import('../src/subcommands/handlers/per-subcommand-help.js');
      expect(mod.deepSubcommandsWithFocusedHelp).toContain('bench:run');
    });
  });
});
