// Tests for the /auth panel's pure data model — row layout, catalog
// filtering, and cursor movement. These are the invariants the reducer,
// the key router, and the component all rely on staying in sync.

import { describe, expect, it } from 'vitest';
import {
  AUTH_PANEL_INITIAL,
  type AuthPanelState,
  type AuthProviderRow,
  authMoveSelected,
  authPanelRows,
  authSelectedProvider,
  filterAuthCatalog,
} from '../src/components/auth-panel-model.js';

function provider(id: string, keyLabels: string[] = []): AuthProviderRow {
  return {
    id,
    type: id,
    family: 'openai-compatible',
    models: [],
    envVars: [],
    keys: keyLabels.map((label, i) => ({
      label,
      masked: 'sk-a…f3k2',
      createdAt: '2026-07-01T00:00:00.000Z',
      active: i === 0,
    })),
  };
}

function panel(over: Partial<AuthPanelState>): AuthPanelState {
  return { ...AUTH_PANEL_INITIAL, open: true, ...over };
}

describe('authPanelRows — list view', () => {
  it('renders providers followed by the four add/sign-in actions', () => {
    const state = panel({ providers: [provider('a'), provider('b')] });
    const rows = authPanelRows(state);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({ kind: 'provider', provider: { id: 'a' } });
    expect(rows[2]).toMatchObject({ kind: 'list-action', action: 'catalog' });
    expect(rows[5]).toMatchObject({ kind: 'list-action', action: 'oauth' });
  });

  it('offers the actions even with zero providers', () => {
    const rows = authPanelRows(panel({}));
    expect(rows.map((r) => (r.kind === 'list-action' ? r.action : r.kind))).toEqual([
      'catalog',
      'local',
      'custom',
      'oauth',
    ]);
  });
});

describe('authPanelRows — provider view', () => {
  it('renders keys then provider actions including model management', () => {
    const state = panel({
      view: 'provider',
      providerId: 'a',
      providers: [provider('a', ['default', 'backup'])],
    });
    const rows = authPanelRows(state);
    expect(rows).toHaveLength(8);
    expect(rows[0]).toMatchObject({ kind: 'key', keyRow: { label: 'default', active: true } });
    expect(rows[2]).toMatchObject({ kind: 'provider-action', action: 'add-key' });
    expect(rows[6]).toMatchObject({ kind: 'provider-action', action: 'add-model' });
    expect(rows[7]).toMatchObject({ kind: 'provider-action', action: 'remove' });
  });

  it('returns no rows when the provider vanished from config', () => {
    const state = panel({ view: 'provider', providerId: 'gone', providers: [provider('a')] });
    expect(authPanelRows(state)).toHaveLength(0);
    expect(authSelectedProvider(state)).toBeUndefined();
  });
});

describe('authPanelRows — other views', () => {
  it('catalog view applies the type-to-filter query', () => {
    const catalog = [
      { id: 'anthropic', name: 'Anthropic', family: 'anthropic', envVars: [], saved: true },
      { id: 'openai', name: 'OpenAI', family: 'openai', envVars: [], saved: false },
      { id: 'groq', name: 'Groq', family: 'openai-compatible', envVars: [], saved: false },
    ];
    const state = panel({ view: 'catalog', catalog, filter: 'open' });
    const rows = authPanelRows(state);
    // "open" matches openai (id) and groq (family openai-compatible).
    expect(rows.map((r) => (r.kind === 'catalog-entry' ? r.entry.id : ''))).toEqual([
      'openai',
      'groq',
    ]);
  });

  it('oauth view lists the three subscription options', () => {
    const rows = authPanelRows(panel({ view: 'oauth' }));
    expect(rows.map((r) => (r.kind === 'oauth-option' ? r.oauth : ''))).toEqual([
      'chatgpt',
      'claude',
      'copilot',
    ]);
  });

  it('flow view has no selectable rows', () => {
    expect(authPanelRows(panel({ view: 'flow' }))).toHaveLength(0);
  });
});

describe('filterAuthCatalog', () => {
  const catalog = [
    { id: 'anthropic', name: 'Anthropic', family: 'anthropic', envVars: [], saved: false },
    { id: 'mistral', name: 'Mistral AI', family: 'openai-compatible', envVars: [], saved: false },
  ];

  it('matches id, name, and family case-insensitively', () => {
    expect(filterAuthCatalog(catalog, 'ANTH')).toHaveLength(1);
    expect(filterAuthCatalog(catalog, 'mistral ai'.toUpperCase())).toHaveLength(1);
    expect(filterAuthCatalog(catalog, 'compatible')).toHaveLength(1);
  });

  it('empty filter returns everything', () => {
    expect(filterAuthCatalog(catalog, '')).toHaveLength(2);
    expect(filterAuthCatalog(catalog, '   ')).toHaveLength(2);
  });
});

describe('authMoveSelected', () => {
  it('wraps around both ends', () => {
    const state = panel({ providers: [provider('a')] }); // 1 + 4 actions = 5 rows
    expect(authMoveSelected({ ...state, selected: 0 }, -1)).toBe(4);
    expect(authMoveSelected({ ...state, selected: 4 }, 1)).toBe(0);
    expect(authMoveSelected({ ...state, selected: 2 }, 1)).toBe(3);
  });

  it('stays at 0 for an empty row list', () => {
    const state = panel({ view: 'flow' });
    expect(authMoveSelected(state, 1)).toBe(0);
    expect(authMoveSelected(state, -1)).toBe(0);
  });
});
