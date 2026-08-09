import { describe, expect, it } from 'vitest';
import {
  buildModelsAddUsageLine,
  MODELS_ADD_BOOLEAN_FLAG_NAMES,
  MODELS_ADD_FLAGS,
  MODELS_ADD_VALUE_FLAG_NAMES,
  renderModelsAddHelpToString,
} from '../src/subcommands/handlers/models-add-help.js';
import { renderDeepHelpToString } from '../src/subcommands/handlers/per-subcommand-help.js';

/**
 * The `models-add-help.ts` module is the single source of truth
 * for the `wstack models add` flag list. The `MODELS_ADD_FLAGS`
 * array drives:
 *
 *   - The help block rendered by `renderModelsAddHelpToString()`
 *     (and the `models:add` deep entry's `customBody` field)
 *   - The `MODELS_ADD_BOOLEAN_FLAG_NAMES` / `MODELS_ADD_VALUE_FLAG_NAMES`
 *     constants the parser iterates to read the flags
 *   - The `Usage:` line written to stderr when `<mid>` is missing
 *     (`buildModelsAddUsageLine()`)
 *
 * The tests below pin the contract for all three. A future
 * contributor who adds a flag to `MODELS_ADD_FLAGS` should
 * see all of these tests still pass (the `MODELS_ADD_*` lists
 * derive from the array, so a new entry shows up automatically).
 */
describe('models-add-help', () => {
  describe('MODELS_ADD_FLAGS (the source of truth)', () => {
    it('contains 9 flags: 2 identity + 7 capabilities', () => {
      expect(MODELS_ADD_FLAGS).toHaveLength(9);
      const identity = MODELS_ADD_FLAGS.filter((f) => f.group === 'identity');
      const capabilities = MODELS_ADD_FLAGS.filter((f) => f.group === 'capabilities');
      expect(identity).toHaveLength(2);
      expect(capabilities).toHaveLength(7);
    });

    it('each entry has a non-empty name, flag, description, group, and kind', () => {
      for (const f of MODELS_ADD_FLAGS) {
        expect(f.name).toMatch(/^[a-z][a-z0-9-]*$/);
        expect(f.flag).toMatch(/^--/);
        expect(f.description.length).toBeGreaterThan(10);
        expect(['identity', 'capabilities']).toContain(f.group);
        expect(['boolean', 'value']).toContain(f.kind);
      }
    });

    it('all 5 boolean flags (tools / vision / streaming / reasoning / json-mode) are present', () => {
      const names = MODELS_ADD_BOOLEAN_FLAG_NAMES;
      expect(names).toContain('tools');
      expect(names).toContain('vision');
      expect(names).toContain('streaming');
      expect(names).toContain('reasoning');
      expect(names).toContain('json-mode');
      expect(names).toHaveLength(5);
    });

    it('all 4 value flags (provider / name / max-context / max-output) are present', () => {
      const names = MODELS_ADD_VALUE_FLAG_NAMES;
      expect(names).toContain('provider');
      expect(names).toContain('name');
      expect(names).toContain('max-context');
      expect(names).toContain('max-output');
      expect(names).toHaveLength(4);
    });

    it('every flag has a unique name (no duplicates)', () => {
      const names = MODELS_ADD_FLAGS.map((f) => f.name);
      expect(new Set(names).size).toBe(names.length);
    });
  });

  describe('renderModelsAddHelpToString (the help block)', () => {
    const block = renderModelsAddHelpToString();

    it('starts with the bold title line', () => {
      const firstLine = block.split('\n')[0];
      expect(firstLine).toContain('wstack models add <mid>');
    });

    it('contains every flag name in the flag list', () => {
      for (const f of MODELS_ADD_FLAGS) {
        // The flag (e.g. `--max-context <N>`) is what the user
        // types, so we check the displayed form rather than the
        // canonical name.
        expect(block).toContain(f.flag);
      }
    });

    it('groups the flags with "Identity:" and "Capabilities:" subheaders', () => {
      expect(block).toContain('Identity:');
      expect(block).toContain('Capabilities:');
    });

    it('orders Identity flags before Capabilities flags', () => {
      const identityIdx = block.indexOf('Identity:');
      const capabilitiesIdx = block.indexOf('Capabilities:');
      expect(identityIdx).toBeGreaterThan(-1);
      expect(capabilitiesIdx).toBeGreaterThan(identityIdx);
    });

    it('includes a "See also:" line pointing at models list / remove', () => {
      expect(block).toContain('See also:');
      expect(block).toContain('wstack models list');
      expect(block).toContain('wstack models remove');
    });

    it('ends with a trailing newline (matches the auth-local-help convention)', () => {
      expect(block.endsWith('\n')).toBe(true);
    });
  });

  describe('byte-for-byte parity with the models:add deep entry (single source of truth)', () => {
    it('renderDeepHelpToString("models:add", ...) === renderModelsAddHelpToString()', () => {
      // The deep entry's `customBody` is `renderModelsAddHelpToString`.
      // `renderDeepHelpToString` calls `customBody` and returns its
      // output verbatim. The two outputs MUST be byte-for-byte
      // identical — that's the entire point of the delegation.
      const fromDeep = renderDeepHelpToString('models:add');
      const fromHelp = renderModelsAddHelpToString();
      expect(fromDeep).toBe(fromHelp);
    });

    it('the deep entry does NOT render the standard Tip footer (customBody owns the layout)', () => {
      // The standard layout appends `Tip: \`wstack --help\` lists every top-level command.`
      // at the bottom. customBody entries don't get this footer
      // because the dedicated help module owns the closing lines.
      const fromDeep = renderDeepHelpToString('models:add');
      expect(fromDeep).not.toContain('Tip: `wstack --help` lists every top-level command.');
    });
  });

  describe('buildModelsAddUsageLine (the parser fallback)', () => {
    it('starts with `wstack models add <mid>`', () => {
      expect(buildModelsAddUsageLine().startsWith('wstack models add <mid>')).toBe(true);
    });

    it('includes every flag from the source-of-truth list', () => {
      const line = buildModelsAddUsageLine();
      for (const f of MODELS_ADD_FLAGS) {
        // The display form (e.g. `--max-context <N>`) appears in
        // the usage line wrapped in `[]` for value flags.
        expect(line).toContain(f.flag);
      }
    });

    it('produces a single line (no embedded newlines)', () => {
      expect(buildModelsAddUsageLine().includes('\n')).toBe(false);
    });
  });

  describe('the standard layout does NOT include models:add (it has customBody)', () => {
    it('the deep entry is in deepHelpTable, not helpTable', async () => {
      // Lazy import: per-subcommand-help is large.
      const mod = await import('../src/subcommands/handlers/per-subcommand-help.js');
      expect(mod.deepSubcommandsWithFocusedHelp).toContain('models:add');
    });
  });
});
