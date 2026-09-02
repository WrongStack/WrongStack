import { describe, expect, it } from 'vitest';
import {
  formatProbeResult,
  initialRefreshState,
  projectProbe,
  selectModelList,
  selectPickedModelId,
  shouldOfferClear,
  shouldOfferSave,
  type ProbeView,
  type RefreshState,
} from '../../src/components/SettingsPanel/ProviderModelsPanel.filter';

/**
 * Pure-logic tests for the `<ProviderModelsPanel>` filter. The
 * component itself is exercised by the browser / typecheck — the
 * data-shaping is tested here in isolation so the contract is
 * explicit.
 */

function okProbe(ids: string[]): ProbeView {
  return { providerId: 'ollama', ok: true, status: 'ok', modelIds: ids, modelCount: ids.length };
}

function failedProbe(status: ProbeView['status'], detail?: string): ProbeView {
  return { providerId: 'ollama', ok: false, status, ...(detail ? { detail } : {}) };
}

describe('initialRefreshState', () => {
  it('returns a fresh state with no in-flight refresh, no result, no pick', () => {
    const s = initialRefreshState();
    expect(s.inFlight).toBe(false);
    expect(s.last).toBeNull();
    expect(s.picked).toBeNull();
  });
});

describe('projectProbe', () => {
  it('drops undefined optional fields', () => {
    const v = projectProbe({ providerId: 'x', ok: true, status: 'ok' });
    expect(v).toEqual({ providerId: 'x', ok: true, status: 'ok' });
  });

  it('preserves all populated fields', () => {
    const v = projectProbe({
      providerId: 'x',
      ok: true,
      status: 'ok',
      httpStatus: 200,
      elapsedMs: 42,
      modelCount: 3,
      modelIds: ['a', 'b', 'c'],
      detail: 'detail text',
    });
    expect(v).toEqual({
      providerId: 'x',
      ok: true,
      status: 'ok',
      httpStatus: 200,
      elapsedMs: 42,
      modelCount: 3,
      modelIds: ['a', 'b', 'c'],
      detail: 'detail text',
    });
  });
});

describe('selectPickedModelId — precedence chain', () => {
  it('prefers the user-picked id (state.picked) over everything else', () => {
    const s: RefreshState = { ...initialRefreshState(), picked: 'user-pick' };
    expect(selectPickedModelId(s, 'saved', ['saved-a'])).toBe('user-pick');
  });

  it("falls back to the probe's first model id when no user pick", () => {
    const s: RefreshState = { ...initialRefreshState(), last: okProbe(['p1', 'p2']) };
    expect(selectPickedModelId(s, 'saved', ['saved-a'])).toBe('p1');
  });

  it('falls back to the saved picked id when no probe result', () => {
    const s = initialRefreshState();
    expect(selectPickedModelId(s, 'saved-picked', undefined)).toBe('saved-picked');
  });

  it('falls back to the first saved model when no pickedModelId and no probe', () => {
    const s = initialRefreshState();
    expect(selectPickedModelId(s, undefined, ['saved-a', 'saved-b'])).toBe('saved-a');
  });

  it('returns empty string when nothing is available', () => {
    expect(selectPickedModelId(initialRefreshState(), undefined, undefined)).toBe('');
    expect(selectPickedModelId(initialRefreshState(), undefined, [])).toBe('');
  });

  it('does not use a failed probe result (no modelIds even if probed list was empty)', () => {
    const s: RefreshState = { ...initialRefreshState(), last: failedProbe('unreachable') };
    expect(selectPickedModelId(s, undefined, ['saved-a'])).toBe('saved-a');
  });
});

describe('selectModelList', () => {
  it("returns the probe's modelIds when ok", () => {
    const s: RefreshState = { ...initialRefreshState(), last: okProbe(['p1', 'p2']) };
    expect(selectModelList(s, ['saved'])).toEqual(['p1', 'p2']);
  });

  it('falls back to saved models when no probe result', () => {
    expect(selectModelList(initialRefreshState(), ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('returns empty array when nothing is available', () => {
    expect(selectModelList(initialRefreshState(), undefined)).toEqual([]);
    expect(selectModelList(initialRefreshState(), [])).toEqual([]);
  });

  it('does not return a list when the probe failed', () => {
    const s: RefreshState = { ...initialRefreshState(), last: failedProbe('http_error') };
    expect(selectModelList(s, ['saved-a', 'saved-b'])).toEqual(['saved-a', 'saved-b']);
  });

  it('does not return a list when the probe ok but empty', () => {
    const s: RefreshState = { ...initialRefreshState(), last: okProbe([]) };
    expect(selectModelList(s, ['saved-a'])).toEqual(['saved-a']);
  });
});

describe('shouldOfferSave', () => {
  it('returns false when the probe never ran', () => {
    expect(shouldOfferSave(initialRefreshState(), ['a', 'b'])).toBe(false);
  });

  it('returns false when the probe failed', () => {
    const s: RefreshState = { ...initialRefreshState(), last: failedProbe('unreachable') };
    expect(shouldOfferSave(s, ['a'])).toBe(false);
  });

  it('returns false when the probe succeeded but produced an empty list', () => {
    const s: RefreshState = { ...initialRefreshState(), last: okProbe([]) };
    expect(shouldOfferSave(s, undefined)).toBe(false);
  });

  it('returns true when the saved list is missing and the probe returned ids', () => {
    const s: RefreshState = { ...initialRefreshState(), last: okProbe(['a', 'b']) };
    expect(shouldOfferSave(s, undefined)).toBe(true);
  });

  it('returns true when the lengths differ', () => {
    const s: RefreshState = { ...initialRefreshState(), last: okProbe(['a', 'b', 'c']) };
    expect(shouldOfferSave(s, ['a', 'b'])).toBe(true);
  });

  it('returns true when the order or contents differ', () => {
    const s: RefreshState = { ...initialRefreshState(), last: okProbe(['a', 'b']) };
    expect(shouldOfferSave(s, ['b', 'a'])).toBe(true);
  });

  it('returns false when the lists match exactly', () => {
    const s: RefreshState = { ...initialRefreshState(), last: okProbe(['a', 'b', 'c']) };
    expect(shouldOfferSave(s, ['a', 'b', 'c'])).toBe(false);
  });
});

describe('shouldOfferClear', () => {
  it('returns false when the saved list is undefined (catalog fallback already in effect)', () => {
    expect(shouldOfferClear(undefined)).toBe(false);
  });

  it('returns false when the saved list is an empty array', () => {
    expect(shouldOfferClear([])).toBe(false);
  });

  it('returns true when the saved list has at least one entry', () => {
    expect(shouldOfferClear(['a'])).toBe(true);
    expect(shouldOfferClear(['a', 'b', 'c'])).toBe(true);
  });

  it('does not consult the local probe state (the button reflects on-disk truth)', () => {
    // Even with an active probe showing a different list, the
    // "Clear" CTA depends only on `savedModels`. The point of the
    // button is "I have a list pinned; revert to catalog" — that
    // question is answered by the saved list alone.
    expect(shouldOfferClear(['a', 'b'])).toBe(true);
    expect(shouldOfferClear(undefined)).toBe(false);
  });
});

describe('formatProbeResult', () => {
  it('returns a muted hint when no refresh has run', () => {
    const r = formatProbeResult(initialRefreshState());
    expect(r.tone).toBe('muted');
    expect(r.text).toContain('Saved model list shown');
  });

  it('returns "Probing…" while in-flight', () => {
    const r = formatProbeResult({ ...initialRefreshState(), inFlight: true });
    expect(r.tone).toBe('muted');
    expect(r.text).toBe('Checking model endpoint...');
  });

  it('formats ok with model count and elapsed ms', () => {
    const r = formatProbeResult({
      ...initialRefreshState(),
      last: { ...okProbe(['a', 'b', 'c']), elapsedMs: 87 },
    });
    expect(r.tone).toBe('success');
    expect(r.text).toContain('3 models');
    expect(r.text).toContain('87ms');
  });

  it('formats ok with the singular for a single model', () => {
    const r = formatProbeResult({
      ...initialRefreshState(),
      last: okProbe(['only-one']),
    });
    expect(r.text).toContain('1 model');
    expect(r.text).not.toContain('1 models');
  });

  it('formats unreachable as an error', () => {
    const r = formatProbeResult({
      ...initialRefreshState(),
      last: failedProbe('unreachable', 'ECONNREFUSED 127.0.0.1:11434'),
    });
    expect(r.tone).toBe('error');
    expect(r.text).toContain('server unreachable');
    expect(r.text).toContain('ECONNREFUSED');
  });

  it('formats timeout as an error with the detail', () => {
    const r = formatProbeResult({
      ...initialRefreshState(),
      last: { ...failedProbe('timeout', '> 3000ms') },
    });
    expect(r.tone).toBe('error');
    expect(r.text).toContain('timed out');
    expect(r.text).toContain('> 3000ms');
  });

  it('formats http_error with status code', () => {
    const r = formatProbeResult({
      ...initialRefreshState(),
      last: {
        ...failedProbe('http_error', 'Bearer sk-leaked-from-proxy'),
        httpStatus: 500,
      },
    });
    expect(r.tone).toBe('warning');
    expect(r.text).toContain('HTTP 500');
    expect(r.text).toContain('sk-leaked-from-proxy');
  });

  it('formats invalid_response as a warning', () => {
    const r = formatProbeResult({
      ...initialRefreshState(),
      last: failedProbe('invalid_response', 'no `data` array'),
    });
    expect(r.tone).toBe('warning');
    expect(r.text).toContain('no `data` array');
  });

  it('formats no_provider as an error', () => {
    const r = formatProbeResult({
      ...initialRefreshState(),
      last: failedProbe('no_provider'),
    });
    expect(r.tone).toBe('error');
    expect(r.text).toContain('Provider is no longer saved');
  });

  it('formats no_base_url as a warning', () => {
    const r = formatProbeResult({
      ...initialRefreshState(),
      last: failedProbe('no_base_url'),
    });
    expect(r.tone).toBe('warning');
    expect(r.text).toContain('No model endpoint configured');
  });
});
