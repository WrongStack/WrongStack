import { describe, expect, it } from 'vitest';
import { reducer } from '../src/app.js';
import { initial } from './reducer.test.js';

describe('reducer — remaining branches', () => {
  // ── Plugin picker ────────────────────────────────────────────────────
  it('pluginPicker open/close/move/setItems/busy/hint', () => {
    let s = reducer(initial(), { type: 'pluginPickerOpen', items: [{ id: 'p1' }] as never });
    expect(s.pluginPicker.open).toBe(true);
    s = reducer(s, { type: 'pluginPickerMove', delta: 1 });
    expect(s.pluginPicker.selected).toBe(0);
    s = reducer(s, { type: 'pluginPickerSetItems', items: [{ id: 'a' }, { id: 'b' }] as never });
    expect(s.pluginPicker.items).toHaveLength(2);
    s = reducer(s, { type: 'pluginPickerBusy', busy: true });
    expect(s.pluginPicker.busy).toBe(true);
    s = reducer(s, { type: 'pluginPickerHint', text: 'loading' });
    expect(s.pluginPicker.hint).toBe('loading');
    s = reducer(s, { type: 'pluginPickerClose' });
    expect(s.pluginPicker.open).toBe(false);
  });
  it('pluginPickerMove no-op on empty', () => {
    expect(reducer(initial(), { type: 'pluginPickerMove', delta: 1 }).pluginPicker.selected).toBe(0);
  });

  // ── MCP picker ──────────────────────────────────────────────────────
  it('mcpPicker open/close/move/setItems/busy/hint', () => {
    let s = reducer(initial(), { type: 'mcpPickerOpen', items: [{ id: 'm1' }] as never });
    expect(s.mcpPicker.open).toBe(true);
    s = reducer(s, { type: 'mcpPickerMove', delta: 1 });
    expect(s.mcpPicker.selected).toBe(0);
    s = reducer(s, { type: 'mcpPickerSetItems', items: [{ id: 'x' }, { id: 'y' }] as never });
    expect(s.mcpPicker.items).toHaveLength(2);
    s = reducer(s, { type: 'mcpPickerBusy', busy: true });
    expect(s.mcpPicker.busy).toBe(true);
    s = reducer(s, { type: 'mcpPickerHint', text: 'ready' });
    expect(s.mcpPicker.hint).toBe('ready');
    s = reducer(s, { type: 'mcpPickerClose' });
    expect(s.mcpPicker.open).toBe(false);
  });
  it('mcpPickerMove no-op on empty', () => {
    expect(reducer(initial(), { type: 'mcpPickerMove', delta: 1 }).mcpPicker.selected).toBe(0);
  });

  // ── Tools picker ────────────────────────────────────────────────────
  it('toolsPicker open/close/move/setItems/busy/hint/filter', () => {
    let s = reducer(initial(), { type: 'toolsPickerOpen', items: [{ name: 'read', owner: 'core', category: 'fs', enabled: true, mutating: false, permission: 'auto', descMode: 'simple', description: 'Read a file' }] });
    expect(s.toolsPicker.open).toBe(true);
    s = reducer(s, { type: 'toolsPickerMove', delta: 1 });
    expect(s.toolsPicker.selected).toBe(0);
    s = reducer(s, { type: 'toolsPickerSetItems', items: [{ name: 'write', owner: 'core', category: 'fs', enabled: true, mutating: true, permission: 'confirm', descMode: 'simple', description: 'Write a file' }] });
    expect(s.toolsPicker.items).toHaveLength(1);
    s = reducer(s, { type: 'toolsPickerFilter', filter: 'write' });
    expect(s.toolsPicker.filter).toBe('write');
    s = reducer(s, { type: 'toolsPickerBusy', busy: true });
    expect(s.toolsPicker.busy).toBe(true);
    s = reducer(s, { type: 'toolsPickerClose' });
    expect(s.toolsPicker.open).toBe(false);
  });
  it('toolsPickerMove no-op on empty', () => {
    expect(reducer(initial(), { type: 'toolsPickerMove', delta: 1 }).toolsPicker.selected).toBe(0);
  });

  // ── Auth panel ──────────────────────────────────────────────────────
  it('authOpen/Close/View/Busy', () => {
    const s = reducer(initial(), { type: 'authOpen' });
    expect(s.authPanel.open).toBe(true);
    expect(reducer(s, { type: 'authView', view: 'catalog' }).authPanel.view).toBe('catalog');
    expect(reducer(s, { type: 'authBusy', busy: true }).authPanel.busy).toBe(true);
    expect(reducer(s, { type: 'authClose' }).authPanel.open).toBe(false);
  });
  it('authCatalog sets catalog', () => {
    expect(reducer(initial(), { type: 'authCatalog', catalog: [{ id: 'openai', name: 'OpenAI', family: 'openai', envVars: ['OPENAI_API_KEY'], saved: false }] }).authPanel.catalog).toHaveLength(1);
  });
  it('authProviders sets providers', () => {
    expect(reducer(initial(), { type: 'authProviders', providers: [{ id: 'openai', models: [], envVars: [], keys: [] }] }).authPanel.providers).toHaveLength(1);
  });
  it('authFilter sets filter', () => {
    expect(reducer(initial(), { type: 'authFilter', filter: 'openai' }).authPanel.filter).toBe('openai');
  });
  it('authMove moves selection', () => {
    const s = initial({ authPanel: { open: true, view: 'list' as const, providers: [{ id: 'a' }, { id: 'b' }], presets: [], catalog: [], selected: 0, filter: '', busy: false, hint: '' } } as never);
    expect(reducer(s, { type: 'authMove', delta: 1 }).authPanel.selected).toBe(1);
  });

  // ── Shadow panel ────────────────────────────────────────────────────
  it('shadowOpen/Close', () => {
    const s = reducer(initial(), { type: 'shadowOpen' } as never);
    expect(s.shadowPanel.open).toBe(true);
    expect(reducer(s, { type: 'shadowClose' }).shadowPanel.open).toBe(false);
  });

  // ── Brain panel ─────────────────────────────────────────────────────
  it('brainView changes view', () => {
    const s = initial({ brainPanel: { open: true, log: [], settings: null, selected: 0, view: undefined, busy: false, hint: undefined } } as never);
    expect(reducer(s, { type: 'brainView', view: 'log' }).brainPanel.view).toBe('log');
  });
  it('brainMove works when open', () => {
    const s = initial({ brainPanel: { open: true, log: [], settings: null, selected: 0, view: undefined, busy: false, hint: undefined } } as never);
    expect(reducer(s, { type: 'brainMove', delta: 1 }).brainPanel.selected).toBe(0);
  });

  // ── Help panel ──────────────────────────────────────────────────────
  it('helpFilter/Close/Move/Hint', () => {
    const s = reducer(initial(), { type: 'helpOpen', entries: [{ name: 'Help', description: 'desc', category: 'general' }] });
    expect(s.helpPanel.open).toBe(true);
    expect(reducer(s, { type: 'helpFilter', filter: 'help' }).helpPanel.filter).toBe('help');
    expect(reducer(s, { type: 'helpMove', delta: 1 }).helpPanel.selected).toBe(0);
    expect(reducer(s, { type: 'helpHint', text: 'use arrows' }).helpPanel.hint).toBe('use arrows');
    expect(reducer(s, { type: 'helpClose' }).helpPanel.open).toBe(false);
  });

  // ── escConfirmOpen/Close ────────────────────────────────────────────
  it('escConfirmOpen/Close', () => {
    const open = reducer(initial(), { type: 'escConfirmOpen' } as never);
    expect(open.escConfirm).toBeDefined();
    expect(reducer(open, { type: 'escConfirmClose' }).escConfirm).toBeNull();
  });
});
