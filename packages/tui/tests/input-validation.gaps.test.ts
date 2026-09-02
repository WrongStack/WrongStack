import { describe, expect, it } from 'vitest';
import {
  MAX_ENTRY_TEXT_CHARS,
  MAX_FLEET_ENTRIES,
  MAX_PICKER_MATCHES,
  validateAction,
} from '../src/input-validation.js';

/**
 * Assert a specific rejection message for an action payload.
 *
 * NOTE: validateAction checks the allow-list BEFORE the type-specific switch,
 * so only action types present in ALLOWED_ACTION_TYPES can reach their switch
 * branch. Several switch cases (setAutonomyMode, setCapability,
 * modelPickerSelect, …) are not on the allow-list and are therefore dead code —
 * see the coverage report discussion. These tests cover the reachable ones.
 */
function expectInvalid(type: string, payload: Record<string, unknown>, errorPart: string) {
  const res = validateAction({ type, ...payload });
  expect(res.valid).toBe(false);
  if (!res.valid) expect(res.error).toContain(errorPart);
}

describe('validateAction — remaining branch coverage', () => {
  it('rejects oversized setBuffer payloads via the generic string cap', () => {
    expectInvalid(
      'setBuffer',
      { buffer: 'x'.repeat(10_001), cursor: 0 },
      'action.buffer: string exceeds',
    );
  });

  it('caps picker match lists', () => {
    const tooMany = Array.from({ length: MAX_PICKER_MATCHES + 1 }, () => ({ label: 'x' }));
    expectInvalid('pickerSetMatches', { matches: tooMany }, `exceeds max ${MAX_PICKER_MATCHES}`);
    expectInvalid('pickerSetMatches', { matches: 'nope' }, 'not an array');
    expect(validateAction({ type: 'pickerSetMatches', matches: [] }).valid).toBe(true);
  });

  it('caps fleet seeds and rejects empty fleet ids', () => {
    expectInvalid(
      'fleetSeed',
      { entries: Array.from({ length: MAX_FLEET_ENTRIES + 1 }, () => ({})) },
      'exceeds max',
    );
    expectInvalid('fleetSeed', { entries: 'nope' }, 'not an array');
    expect(validateAction({ type: 'fleetSeed', entries: [] }).valid).toBe(true);

    for (const type of ['fleetToolStart', 'fleetToolEnd', 'fleetTool', 'fleetDone', 'fleetCost']) {
      expectInvalid(type, { id: '' }, 'empty or missing');
      expect(validateAction({ type, id: 'sub-1' }).valid).toBe(true);
    }
  });

  it('enforces the fleet chat mode allow-list', () => {
    expectInvalid('setFleetChat', { mode: 'yell' }, 'not on allow-list');
    expect(validateAction({ type: 'setFleetChat', mode: 'concise' }).valid).toBe(true);
  });

  it('requires objects for confirm panel infos', () => {
    for (const type of [
      'clearConfirmOpen',
      'exitConfirmOpen',
      'slashConfirmOpen',
      'escConfirmOpen',
      'fallbackOverlayOpen',
    ]) {
      expectInvalid(type, { info: null }, 'missing or non-object');
      expect(validateAction({ type, info: { question: 'q' } }).valid).toBe(true);
    }
    expectInvalid('clearConfirmSetValue', { value: 'v'.repeat(101) }, 'exceeds 100 chars');
    expect(validateAction({ type: 'clearConfirmSetValue', value: 'yes' }).valid).toBe(true);
  });

  it('validates checkpoint payloads and rewind overlays', () => {
    expectInvalid('checkpointReceived', { cp: null }, 'missing or non-object');
    expectInvalid('checkpointReceived', { cp: { promptIndex: -1 } }, 'not a non-negative integer');
    expectInvalid('checkpointReceived', { cp: { promptIndex: 'x' } }, 'not a non-negative integer');
    expect(validateAction({ type: 'checkpointReceived', cp: { promptIndex: 4 } }).valid).toBe(true);

    expectInvalid('rewindOverlayOpen', { checkpoints: 'nope' }, 'not an array');
    expect(
      validateAction({ type: 'rewindOverlayOpen', checkpoints: [{ promptIndex: 0 }] }).valid,
    ).toBe(true);
  });

  it('caps goal titles and validates phase counters', () => {
    expectInvalid('goalRunInit', { title: 't'.repeat(501) }, 'exceeds 500 chars');
    expect(validateAction({ type: 'goalRunInit', title: 'Ship it' }).valid).toBe(true);

    expectInvalid('goalRunPhaseUpdate', { completedTasks: -1, totalTasks: 2 }, 'completedTasks');
    expectInvalid('goalRunPhaseUpdate', { completedTasks: 1, totalTasks: 'x' }, 'totalTasks');
    expect(
      validateAction({ type: 'goalRunPhaseUpdate', completedTasks: 1, totalTasks: 2 }).valid,
    ).toBe(true);
  });

  it('validates debug stream counters', () => {
    expectInvalid('debugStreamStats', { chunkCount: -1 }, 'chunkCount');
    expectInvalid('debugStreamStats', { chunkCount: 1, lastChunkSize: -1 }, 'lastChunkSize');
    expectInvalid(
      'debugStreamStats',
      { chunkCount: 1, lastChunkSize: 1, totalBytes: -5 },
      'totalBytes',
    );
    expect(
      validateAction({ type: 'debugStreamStats', chunkCount: 1, lastChunkSize: 2, totalBytes: 3 })
        .valid,
    ).toBe(true);
  });

  it('validates session panel payloads and busy toggles', () => {
    expectInvalid('sessionsPanelSet', { sessions: 'nope' }, 'not an array');
    expectInvalid(
      'sessionsPanelSet',
      { sessions: Array.from({ length: 201 }, () => ({})) },
      'exceeds max 200',
    );
    expect(validateAction({ type: 'sessionsPanelSet', sessions: [] }).valid).toBe(true);

    expectInvalid('sessionsPanelBusy', { on: 'yes' }, 'not a boolean');
    expect(validateAction({ type: 'sessionsPanelBusy', on: true }).valid).toBe(true);

    expectInvalid('topicCheckBusy', { on: 1 }, 'not a boolean');
    expect(validateAction({ type: 'topicCheckBusy', on: true }).valid).toBe(true);

    expectInvalid('sessionResumeConfirmSet', { sessionId: '' }, 'empty');
    expect(validateAction({ type: 'sessionResumeConfirmSet', sessionId: 's1' }).valid).toBe(true);
  });

  it('rejects text-bearing entries over the entry cap through addEntry', () => {
    expectInvalid(
      'addEntry',
      { entry: { kind: 'info', text: 'x'.repeat(MAX_ENTRY_TEXT_CHARS + 1) } },
      'addEntry.entry.text',
    );
  });
});
