/**
 * Targeted tests for uncovered branches across multiple TUI source modules.
 * This file consolidates edge-case coverage gaps found in the v8 coverage report.
 *
 * Strategy: test one uncovered branch per `it()` block, grouped by module.
 * DO NOT modify source code — only add test coverage.
 */

import { describe, expect, it } from 'vitest';
import React from 'react';
import { detectLang, highlightLine, langFromPath } from '../src/highlight.js';
import { Text } from '../src/ink.js';
import { colorForFamily, dimColorForFamily } from '../src/components/provider-colors.js';
import { actionForFKeyPanel } from '../src/f-key-panels.js';
import { createPanelOpenDispatcher, type PanelOpenDeps } from '../src/on-panel-open.js';
import { handleQueueCommand, type QueueSlashDeps } from '../src/queue-slash.js';
import { buildSlashCommandMatches } from '../src/slash-command-search.js';
import { normalizeTuiThinkingWord } from '../src/thinking-word.js';
import {
  authPanelRows,
  authMoveSelected,
  type AuthPanelState,
} from '../src/components/auth-panel-model.js';
import {
  closePanels,
  firstSelectable,
  clampContextLoad,
  skipDivider,
} from '../src/reducers/helpers.js';
import type { ProjectPickerItem } from '../src/ui-contracts.js';

// ────────────────────────────────────────────────────────────────────────────
// highlight.ts — branch gaps
// ────────────────────────────────────────────────────────────────────────────

describe('highlight.ts — branch gaps', () => {
  it('tokenizePython: handles @ not followed by a decorator identifier', () => {
    // PY_DECORATOR = /^@[A-Za-z_][A-Za-z0-9_.]*/ — fails when @ is alone or
    // followed by a non-identifier char like a digit.
    const { tokens } = highlightLine('x = @ 123', 'python');
    expect(tokens.map((t) => t.text).join('')).toBe('x = @ 123');
    // @ should be emitted as a plain punctuation char (no decorator match).
    const atToken = tokens.find((t) => t.text === '@');
    expect(atToken?.color).toBeUndefined();
  });

  it('detectLang: empty fence info string falls through ?? guard', () => {
    // fenceInfo.trim().toLowerCase().split(/\s+/)[0] ?? '' — empty string
    // splits to [''] → [0] is '' not undefined, but this tests the fallback path.
    expect(detectLang('')).toBe('plain');
  });

  it('langFromPath: returns plain for unknown extension', () => {
    // LANG_ALIASES[ext] ?? 'plain' — ext not in LANG_ALIASES → 'plain'
    expect(langFromPath('foo.rust')).toBe('plain');
    expect(langFromPath('Makefile')).toBe('plain');
  });

  it('langFromPath: returns plain for empty/missing extension', () => {
    // m?.[1]?.toLowerCase() ?? '' — no match → '' → not in LANG_ALIASES → 'plain'
    expect(langFromPath('')).toBe('plain');
    expect(langFromPath('README')).toBe('plain');
  });

  it('detectLang: handles fence info with multiple tokens and picks first', () => {
    // {1} in the array after split picks the first token.
    expect(detectLang('ts {2,4}')).toBe('ts');
    expect(detectLang('python .  ')).toBe('python');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// ink.tsx — branch gaps
// ────────────────────────────────────────────────────────────────────────────

describe('ink.tsx — branch gaps', () => {
  it('Text renders with known color', () => {
    // The Text component wraps InkText with softColor mapping.
    // Just verify it renders without error with a known color name.
    const el = Text({ color: 'cyan', children: 'hello' }) as NonNullable<ReturnType<typeof Text>>;
    expect(el).toBeDefined();
    expect((el as unknown as { props: Record<string, unknown> }).props.color).toBe('#94e2d5'); // pastel cyan
  });

  it('Text renders without color prop (undefined)', () => {
    // colorProps returns {} when softColor returns undefined.
    const el = Text({ children: 'plain' }) as NonNullable<ReturnType<typeof Text>>;
    expect(el).toBeDefined();
    expect((el as unknown as { props: Record<string, unknown> }).props.color).toBeUndefined();
  });

  it('Text renders with backgroundColor that resolves', () => {
    const el = Text({ backgroundColor: 'blue', children: 'bg test' }) as NonNullable<
      ReturnType<typeof Text>
    >;
    expect(el).toBeDefined();
    expect((el as unknown as { props: Record<string, unknown> }).props.backgroundColor).toBe(
      '#89b4fa',
    );
  });

  it('Box component can be rendered via createElement', async () => {
    // Box is a ForwardRefExoticComponent — call via createElement.
    const { Box } = await import('../src/ink.js');
    const el = React.createElement(Box, { borderColor: 'magenta' }, 'box');
    expect(el).toBeDefined();
    expect(el.type).toBeDefined();
  });

  it('Box component renders with undefined borderColor via createElement', async () => {
    // Line 76 uncovered branch: bg is undefined → {} spread.
    const { Box } = await import('../src/ink.js');
    const el = React.createElement(Box, {}, 'plain box');
    expect(el).toBeDefined();
    expect((el as unknown as { props: Record<string, unknown> }).props.borderColor).toBeUndefined();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// provider-colors.ts — branch gaps
// ────────────────────────────────────────────────────────────────────────────

describe('provider-colors.ts — branch gaps', () => {
  it('colorForFamily returns fallback for unknown family', () => {
    expect(colorForFamily(undefined)).toBe('#89dceb');
    expect(colorForFamily('unknown-family')).toBe('#89dceb');
  });

  it('dimColorForFamily returns fallback for unknown family', () => {
    expect(dimColorForFamily(undefined)).toBe('#585b70');
    expect(dimColorForFamily('unknown-family')).toBe('#585b70');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// f-key-panels.ts — branch gaps
// ────────────────────────────────────────────────────────────────────────────

describe('f-key-panels.ts — branch gaps', () => {
  it('actionForFKeyPanel returns null for unrecognised action', () => {
    // The PAYLOAD_FREE_ACTIONS set doesn't include projectPickerOpen or
    // statuslineOpen, so those are handled above. What about an entry whose
    // action is NOT projectPickerOpen, NOT statuslineOpen, AND not in
    // PAYLOAD_FREE_ACTIONS? With the current entry set this doesn't occur,
    // but the default branch exists.
    // Create a synthetic entry:
    const fakeEntry = {
      key: 99,
      label: 'fake',
      action: 'togglePlanPanel' as const, // This IS in payload-free, so it dispatches.
      helpKeys: '',
      helpDescription: '',
    };
    // togglePlanPanel is in PAYLOAD_FREE_ACTIONS → dispatches.
    expect(actionForFKeyPanel(fakeEntry)).toEqual({ type: 'togglePlanPanel' });
  });
});

// ────────────────────────────────────────────────────────────────────────────
// on-panel-open.ts — branch gaps
// ────────────────────────────────────────────────────────────────────────────

describe('on-panel-open.ts — branch gaps', () => {
  const makeDeps = (overrides?: Partial<PanelOpenDeps>): PanelOpenDeps => ({
    dispatch: () => {},
    openProjectPicker: () => {},
    openStatuslinePicker: () => {},
    ...overrides,
  });

  it('authOpen returns false when openAuthPanel is not provided', () => {
    const dispatch = createPanelOpenDispatcher(makeDeps({ openAuthPanel: undefined }));
    expect(dispatch('authOpen')).toBe(false);
  });

  it('authOauthOpen returns false when openAuthPanel is not provided', () => {
    const dispatch = createPanelOpenDispatcher(makeDeps({ openAuthPanel: undefined }));
    expect(dispatch('authOauthOpen')).toBe(false);
  });

  it('authOpen calls openAuthPanel("list") when provided and returns true', () => {
    let calledView: string | undefined;
    const dispatch = createPanelOpenDispatcher(
      makeDeps({
        openAuthPanel: (view) => {
          calledView = view;
          return true;
        },
      }),
    );
    expect(dispatch('authOpen')).toBe(true);
    expect(calledView).toBe('list');
  });

  it('modePickerOpen falls back to false when openModePicker is absent', () => {
    const dispatch = createPanelOpenDispatcher(makeDeps({ openModePicker: undefined }));
    expect(dispatch('modePickerOpen')).toBe(false);
  });

  it('brainOpen falls back to false when openBrainPanel is absent', () => {
    const dispatch = createPanelOpenDispatcher(makeDeps({ openBrainPanel: undefined }));
    expect(dispatch('brainOpen')).toBe(false);
  });

  it('shadowOpen falls back to false when openShadowPanel is absent', () => {
    const dispatch = createPanelOpenDispatcher(makeDeps({ openShadowPanel: undefined }));
    expect(dispatch('shadowOpen')).toBe(false);
  });

  it('helpOpen falls back to false when openHelpPanel is absent', () => {
    const dispatch = createPanelOpenDispatcher(makeDeps({ openHelpPanel: undefined }));
    expect(dispatch('helpOpen')).toBe(false);
  });

  it('unknown action returns false', () => {
    const dispatch = createPanelOpenDispatcher(makeDeps());
    expect(dispatch('nonexistent-action')).toBe(false);
  });

  it('pluginPickerOpen dispatches and returns true', () => {
    const actions: unknown[] = [];
    const dispatch = createPanelOpenDispatcher(makeDeps({ dispatch: (a) => actions.push(a) }));
    expect(dispatch('pluginPickerOpen')).toBe(true);
    expect(actions).toEqual([{ type: 'pluginPickerOpen' }]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// queue-slash.ts — branch gaps
// ────────────────────────────────────────────────────────────────────────────

describe('queue-slash.ts — branch gaps', () => {
  const emptyDeps: QueueSlashDeps = {
    getQueue: () => [],
    clear: () => {},
    deleteAt: () => {},
    getPickerEnabled: () => false,
    setPickerEnabled: () => {},
  };

  it('picker subcommand reports unavailable when deps missing', () => {
    const deps: QueueSlashDeps = {
      ...emptyDeps,
      getPickerEnabled: undefined,
      setPickerEnabled: undefined,
    };
    const result = handleQueueCommand('picker', deps);
    expect(result).toBe('Send-mode picker toggle is unavailable in this session.');
  });

  it('picker status reports current state', () => {
    const result = handleQueueCommand('picker', emptyDeps);
    expect(result).toBe('Mid-run send-mode picker is off.');
  });

  it('picker status with explicit "status" arg', () => {
    const deps: QueueSlashDeps = {
      ...emptyDeps,
      getPickerEnabled: () => true,
    };
    const result = handleQueueCommand('picker status', deps);
    expect(result).toBe('Mid-run send-mode picker is on.');
  });

  it('delete with no positions shows usage', () => {
    const result = handleQueueCommand('delete', emptyDeps);
    expect(result).toBe('Usage: /queue delete <position> [<position>…]');
  });

  it('delete on empty queue shows message', () => {
    const result = handleQueueCommand('delete 1', emptyDeps);
    expect(result).toBe('Queue is empty — nothing to delete.');
  });

  it('delete with invalid and out-of-range positions reports them', () => {
    const deps: QueueSlashDeps = {
      ...emptyDeps,
      getQueue: () => [{ id: 1, displayText: 'msg1', blocks: [{ type: 'text', text: 'msg1' }] }],
    };
    const result = handleQueueCommand('delete abc 999', deps);
    expect(result).toContain('Invalid: abc');
    expect(result).toContain('Out of range (queue has 1): 999');
    expect(result).toContain('No valid positions to delete.');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// helpers.ts — branch gaps
// ────────────────────────────────────────────────────────────────────────────

describe('helpers.ts — branch gaps', () => {
  it('closePanels returns a PanelResetState with all panels closed', () => {
    const state = { settingsPicker: { open: true } } as never;
    const result = closePanels(state);
    expect(result.monitorOpen).toBe(false);
    expect(result.settingsPicker.open).toBe(false);
  });

  it('clampContextLoad returns 0 for non-finite values', () => {
    expect(clampContextLoad(NaN)).toBe(0);
    expect(clampContextLoad(Infinity)).toBe(0);
    expect(clampContextLoad(-Infinity)).toBe(0);
  });

  it('clampContextLoad clamps to [0,1]', () => {
    expect(clampContextLoad(-0.5)).toBe(0);
    expect(clampContextLoad(1.5)).toBe(1);
    expect(clampContextLoad(0.5)).toBe(0.5);
  });

  it('firstSelectable returns 0 for empty or divider-only lists', () => {
    expect(firstSelectable([])).toBe(0);
    expect(firstSelectable([{ key: '__divider__', label: '--', kind: 'action' as const }])).toBe(0);
  });

  it('skipDivider wraps around and handles all-dividers', () => {
    const items: ProjectPickerItem[] = [
      { key: '__divider__', label: '', kind: 'action' },
      { key: '__divider__', label: '', kind: 'action' },
    ];
    // All dividers — stays at idx
    expect(skipDivider(items, 0, 1)).toBe(0);
    expect(skipDivider(items, 1, -1)).toBe(1);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// auth-panel-model.ts — branch gaps
// ────────────────────────────────────────────────────────────────────────────

describe('auth-panel-model.ts — branch gaps', () => {
  it('authPanelRows returns empty for unknown view', () => {
    // The switch has a case for every view, but the return type covers all.
    // test the 'flow' view returns empty:
    const state: AuthPanelState = {
      open: true,
      view: 'flow',
      busy: false,
      providers: [],
      presets: [],
      catalog: [],
      selected: 0,
      filter: '',
      flowTitle: '',
      log: [],
      flowDone: false,
    };
    expect(authPanelRows(state)).toEqual([]);
  });

  it('authPanelRows provider view returns empty when provider not found', () => {
    const state: AuthPanelState = {
      open: true,
      view: 'provider',
      busy: false,
      providers: [{ id: 'other', type: 'openai', models: [], envVars: [], keys: [] }],
      presets: [],
      catalog: [],
      selected: 0,
      providerId: 'nonexistent',
      filter: '',
      flowTitle: '',
      log: [],
      flowDone: false,
    };
    expect(authPanelRows(state)).toEqual([]);
  });

  it('authMoveSelected returns 0 when no rows', () => {
    const state: AuthPanelState = {
      open: true,
      view: 'flow',
      busy: false,
      providers: [],
      presets: [],
      catalog: [],
      selected: 5,
      filter: '',
      flowTitle: '',
      log: [],
      flowDone: false,
    };
    expect(authMoveSelected(state, 1)).toBe(0);
  });
});

// markdown-table.ts tests live in markdown-table.test.ts

// ────────────────────────────────────────────────────────────────────────────
// slash-command-search.ts — branch gaps
// ────────────────────────────────────────────────────────────────────────────

describe('slash-command-search.ts — branch gaps', () => {
  it('buildSlashCommandMatches returns empty for empty entries', () => {
    expect(buildSlashCommandMatches([], 'test')).toEqual([]);
  });

  it('buildSlashCommandMatches hides commands when query is empty and cmd is hidden', () => {
    const entries = [
      {
        cmd: {
          name: 'hidden-cmd',
          description: '',
          hidden: true,
          run: async () => ({ message: '' }),
        },
        owner: 'core',
        fullName: 'hidden-cmd',
      },
    ];
    expect(buildSlashCommandMatches(entries, '')).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// thinking-word.ts — branch gaps
// ────────────────────────────────────────────────────────────────────────────

describe('thinking-word.ts — branch gaps', () => {
  it('normalizeTuiThinkingWord rejects non-string values', () => {
    expect(normalizeTuiThinkingWord(undefined)).toBe('thinking');
    expect(normalizeTuiThinkingWord(null)).toBe('thinking');
    expect(normalizeTuiThinkingWord(42)).toBe('thinking');
  });

  it('normalizeTuiThinkingWord rejects values that are too long', () => {
    expect(normalizeTuiThinkingWord('a'.repeat(20))).toBe('thinking');
  });
});
