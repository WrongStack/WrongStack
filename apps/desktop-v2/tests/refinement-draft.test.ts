// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import type { FormDraftSnapshot, FormDraftStorage } from '../src/durable-form-draft';
import {
  type RefinementDraft,
  refinementDraftCodec,
  refinementDraftResult,
} from '../src/refinement-draft';
import { useRefinementDraft } from '../src/useRefinementDraft';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const draft: RefinementDraft = {
  original: 'fix the parser',
  mode: 'queue',
  draftAtOpen: 'fix the parser',
  freshContext: false,
  result: {
    refined: 'Fix the parser for empty input.',
    english: 'Fix the parser for empty input.',
    refinedWith: { provider: 'local', model: 'm1' },
  },
  variant: 'refined',
  edited: 'Fix the parser for empty and null input.',
  savedAt: 1_800_000_000_000,
};

describe('refinement review draft', () => {
  it('round-trips a completed review with its edits and provenance', () => {
    expect(refinementDraftCodec.parse(refinementDraftCodec.serialize(draft))).toEqual(draft);
    expect(refinementDraftCodec.parse(null)).toBeNull();
  });
  it('keeps only the reviewable fields of the engine reply', () => {
    expect(
      refinementDraftResult({
        refined: 'R',
        english: '  ',
        refinedWith: { provider: 'p', model: 'm', secret: 'x' },
        usage: { tokens: 3 },
      }),
    ).toEqual({ refined: 'R', refinedWith: { provider: 'p', model: 'm' } });
    // No refined text means there is nothing to review or restore.
    expect(refinementDraftResult({ refined: '' })).toBeNull();
  });
  it('refuses foreign or inconsistent reviews', () => {
    const bad = [
      { ...draft, version: 2 },
      { ...draft, mode: 'later' },
      { ...draft, original: '' },
      { ...draft, variant: 'english', result: { refined: 'R' } },
      { ...draft, edited: 3 },
      { ...draft, freshContext: 'no' },
      { ...draft, result: { refined: 'x'.repeat(1_000_001) } },
    ];
    for (const value of bad)
      expect(() =>
        refinementDraftCodec.parse({
          version: 1,
          ...value,
          ...('version' in value ? { version: value.version } : {}),
        }),
      ).toThrow(/unsupported format/);
  });

  it('keeps a request still waiting for the refiner as pending, without a reply', () => {
    const pending = { ...draft, result: null, pending: true as const, edited: null };
    expect(
      refinementDraftCodec.parse(refinementDraftCodec.serialize(pending) as never),
    ).toMatchObject({ result: null, pending: true });
    // Without the pending mark a review must carry a reply.
    expect(() =>
      refinementDraftCodec.parse({ version: 1, ...draft, result: null } as never),
    ).toThrow(/unsupported format/);
  });

  it('returns false from save when storage is not ready or in conflict so closing a pending dialog preserves a saved reply', async () => {
    const pending = { ...draft, result: null, pending: true as const, edited: null };
    let resolveLoad!: (snap: FormDraftSnapshot) => void;
    let persisted: unknown = refinementDraftCodec.serialize(draft);
    const storage: FormDraftStorage = {
      get: () =>
        new Promise<FormDraftSnapshot>((resolve) => {
          resolveLoad = resolve;
        }),
      save: async (value, rev) => {
        persisted = value;
        return rev + 1;
      },
    };
    let current!: ReturnType<typeof useRefinementDraft>;
    function Harness() {
      current = useRefinementDraft(storage);
      return null;
    }
    const host = document.createElement('div');
    const root = createRoot(host);
    await act(async () => {
      root.render(createElement(Harness));
    });
    expect(current.save(pending)).toBe(false);
    await act(async () => {
      resolveLoad({ revision: 1, value: persisted });
      await new Promise((r) => setTimeout(r, 0));
    });
    expect(current.saved?.result?.refined).toBe(draft.result?.refined);
    expect(current.save(pending)).toBe(false);
    act(() => root.unmount());
  });
});
