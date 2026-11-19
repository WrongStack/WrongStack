import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Action } from '../src/app-action-type.js';
import type { State } from '../src/app-state.js';
import { AUTH_PANEL_INITIAL } from '../src/auth-panel-model.js';
import { routePickerPaste } from '../src/hooks/use-picker-keys-paste.js';
import type { PickerKeysHost } from '../src/hooks/use-picker-keys-types.js';
import { createTestState } from './helpers/create-test-state.js';

/**
 * Every picker text field must take a paste whole, cleaned of controls, and no
 * paste may reach a picker's letter shortcuts or y/N confirmations.
 */

const PASTE = '  foo bar\n';
const CLEAN = 'foo bar';

function run(overrides: Record<string, unknown>, input = PASTE) {
  const actions: Action[] = [];
  const host = {
    state: createTestState(overrides) as State,
    dispatch: (action: Action) => actions.push(action),
    submit: vi.fn(),
  } as unknown as PickerKeysHost;
  const consumed = routePickerPaste(host, input);
  return { consumed, actions, host };
}

describe('picker paste routing — text fields', () => {
  const cases: Array<[string, Record<string, unknown>, Action]> = [
    [
      'auth prompt (API key / redirect URL)',
      {
        authPanel: {
          ...AUTH_PANEL_INITIAL,
          open: true,
          view: 'flow',
          input: { label: 'API key', masked: true, draft: 'x' },
        },
      },
      { type: 'authPromptChange', draft: `x${CLEAN}` },
    ],
    [
      'auth catalog filter',
      { authPanel: { ...AUTH_PANEL_INITIAL, open: true, view: 'catalog', filter: 'a' } },
      { type: 'authFilter', filter: `a${CLEAN}` },
    ],
    [
      'model search',
      { modelPicker: { open: true, step: 'model', searchQuery: 'q' } },
      { type: 'modelPickerSearch', query: `q${CLEAN}` },
    ],
    [
      'theme filter',
      { themePicker: { open: true, filtering: true, filter: 't' } },
      { type: 'themePickerFilter', text: `t${CLEAN}` },
    ],
    [
      'resource menu filter',
      { resourceMenu: { open: true, filtering: true, filter: 'r' } },
      { type: 'resourceMenuFilter', filter: `r${CLEAN}`, active: true },
    ],
    [
      'settings thinking word',
      { settingsPicker: { open: true, thinkingWordEditing: true, thinkingWordDraft: 'w' } },
      { type: 'settingsThinkingEditChange', draft: `w${CLEAN}` },
    ],
    [
      'settings proxy URL',
      { settingsPicker: { open: true, wrongProxyUrlEditing: true, wrongProxyUrlDraft: 'h' } },
      { type: 'settingsWrongProxyUrlEditChange', draft: `h${CLEAN}` },
    ],
    [
      'settings filter starts with its slash',
      { settingsPicker: { open: true, filter: '' } },
      { type: 'settingsFilterSet', filter: `/${CLEAN}` },
    ],
    [
      'tools filter',
      { toolsPicker: { open: true, filter: undefined } },
      { type: 'toolsPickerFilter', filter: CLEAN },
    ],
    [
      'help filter',
      { helpPanel: { open: true, filter: 'h' } },
      { type: 'helpFilter', filter: `h${CLEAN}` },
    ],
    [
      'statusline filter',
      { statuslinePicker: { open: true, filtering: true, filter: 's' } },
      { type: 'statuslineFilter', text: `s${CLEAN}` },
    ],
    [
      'project filter',
      { projectPicker: { open: true, filter: 'p' } },
      { type: 'projectPickerFilter', filter: `p${CLEAN}` },
    ],
  ];

  for (const [name, overrides, expected] of cases) {
    it(`${name} takes the whole paste, trimmed and control-free`, () => {
      const { consumed, actions } = run(overrides);
      expect(consumed).toBe(true);
      expect(actions).toEqual([expected]);
    });
  }

  it('auth form text field appends the paste to the focused field', () => {
    const { actions } = run({
      authPanel: {
        ...AUTH_PANEL_INITIAL,
        open: true,
        view: 'form',
        selected: 4, // alias
        form: {
          kind: 'setup',
          fields: {
            type: 'anthropic',
            name: 'Anthropic',
            family: 'openai-compatible',
            baseUrl: 'https://api.anthropic.com',
            alias: 'anthropic',
            keyLabel: 'default',
            apiKey: '',
            models: '',
            envVars: '',
          },
        },
      },
    });
    expect(actions).toEqual([
      { type: 'authFormChange', field: 'alias', value: `anthropic${CLEAN}` },
    ]);
  });

  it('mcp editor appends to the focused field', () => {
    const editor = {
      mode: 'add',
      field: 2,
      name: '',
      transport: 'stdio',
      target: 'npx',
      args: '[]',
    };
    const { actions } = run({ mcpPicker: { open: true, busy: false, editor } });
    expect(actions).toEqual([
      { type: 'mcpPickerEditor', editor: { ...editor, target: `npx${CLEAN}` } },
    ]);
  });
});

describe('picker paste routing — never a shortcut or confirmation', () => {
  it('a pasted "y" does not confirm deleting an auth key', () => {
    const { consumed, actions } = run(
      {
        authPanel: {
          ...AUTH_PANEL_INITIAL,
          open: true,
          view: 'provider',
          confirm: {
            question: 'Delete key?',
            action: { kind: 'delete-key', providerId: 'p', label: 'default' },
          },
        },
      },
      'y',
    );
    expect(consumed).toBe(true);
    expect(actions).toEqual([]);
  });

  it('a pasted "y" does not run a pending resource-menu command', () => {
    const { consumed, actions, host } = run(
      { resourceMenu: { open: true, pendingAction: { command: '/x', label: 'x' } } },
      'y',
    );
    expect(consumed).toBe(true);
    expect(actions).toEqual([]);
    expect(host.submit).not.toHaveBeenCalled();
  });

  it('a pasted "y" does not confirm removing an MCP server', () => {
    const editor = {
      mode: 'remove',
      field: 0,
      name: 's',
      transport: 'stdio',
      target: '',
      args: '',
    };
    const { actions } = run({ mcpPicker: { open: true, busy: false, editor } }, 'y');
    expect(actions).toEqual([]);
  });

  it('a list view drops the paste instead of reading it as keys', () => {
    for (const overrides of [
      { authPanel: { ...AUTH_PANEL_INITIAL, open: true, view: 'provider' } },
      { modelPicker: { open: true, step: 'provider' } },
      { themePicker: { open: true, filtering: false } },
      { mcpPicker: { open: true, busy: false } },
      { pluginPicker: { open: true } },
      { resumePicker: { open: true } },
      { sessionsPanelOpen: true },
    ]) {
      const { consumed, actions } = run(overrides, 'd');
      expect(consumed).toBe(true);
      expect(actions).toEqual([]);
    }
  });

  it('composer helpers and an idle screen leave the paste to the draft', () => {
    expect(run({ slashPicker: { open: true } }).consumed).toBe(false);
    expect(run({ picker: { open: true } }).consumed).toBe(false);
    expect(run({ skillPicker: { open: true, mention: true } }).consumed).toBe(false);
    expect(run({}).consumed).toBe(false);
  });
});

it('the paste table covers every picker the key dispatch handles', () => {
  const dir = join(__dirname, '../src/hooks');
  const dispatchFlags = new Set<string>();
  for (const file of readdirSync(dir)) {
    if (!file.startsWith('use-picker-keys-') || file === 'use-picker-keys-paste.ts') continue;
    const source = readFileSync(join(dir, file), 'utf8');
    for (const m of source.matchAll(/^ {2}if \(state\.(\w+)(?:\?)?(?:\.open)?\) \{/gm)) {
      dispatchFlags.add(m[1]!);
    }
  }
  const table = readFileSync(join(dir, 'use-picker-keys-paste.ts'), 'utf8');
  const missing = [...dispatchFlags].filter(
    (flag) =>
      !new RegExp(`state\\.${flag}\\b`).test(table) && !['slashPicker', 'picker'].includes(flag),
  );
  expect(dispatchFlags.size).toBeGreaterThan(20);
  expect(missing).toEqual([]);
});
