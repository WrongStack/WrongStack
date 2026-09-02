// Integration tests for the RefinePanel ↔ ChatInput wiring around the
// copy-to-input and cancel handlers.
//
// The full ChatInput component drags in WebSocket, ~7 stores, i18n, slash
// routing, paste/drop, and image attachments — mounting it whole makes these
// tests brittle without adding coverage of the behaviour we care about. What
// we actually need to lock is the CONTRACT between RefinePanel's callbacks and
// the real React input state:
//
//   • onCopyToInput(text) → the input becomes exactly `text`, nothing is sent.
//   • onDecision('cancel') → if the input already holds a copied version it is
//     kept; otherwise the original prompt is restored. Nothing is sent.
//
// So we mount a tiny harness that owns a REAL `useState` input (mirroring
// ChatInput's `const [input, setInput] = useState(...)`) and wires the SAME
// handler bodies ChatInput uses — including the exported `resolveCancelInput`
// helper, so the harness and production share one source of truth. We render
// the actual RefinePanel and drive it through its real buttons, then assert on
// the observable input value and a `send` spy.

import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mocks (same stubs the sibling RefinePanel test uses) ────────────────
vi.mock('@/i18n', () => ({
  useAppTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      if (opts && 'seconds' in opts) return `${key}:${String(opts.seconds)}`;
      return key;
    },
  }),
}));

const localPrefsState = {
  enhanceLanguage: 'original' as 'original' | 'english',
  yolo: false,
};
vi.mock('@/stores/local-prefs', () => ({
  useLocalPrefs: (selector: (s: typeof localPrefsState) => unknown) => selector(localPrefsState),
}));

const updatePrefsMock = vi.fn();
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ updatePrefs: updatePrefsMock }),
}));

import { RefinePanel } from '../../src/components/RefinePanel.js';
import { resolveCancelInput } from '../../src/components/ChatInput.js';
import { useUIStore } from '../../src/stores/ui-store.js';

beforeEach(() => {
  localPrefsState.enhanceLanguage = 'original';
  localPrefsState.yolo = false;
  updatePrefsMock.mockClear();
  useUIStore.setState({ refinePanel: null });
});

afterEach(() => {
  vi.useRealTimers();
});

// ── Harness ─────────────────────────────────────────────────────────────
// Mirrors ChatInput's real input state + the exact handler bodies that wire
// RefinePanel → setInput. `initialInput` lets a test simulate "input was
// cleared to '' at submit time" vs. "a version was already copied in".

interface HarnessProps {
  initialInput?: string;
  original?: string;
  refined?: string;
  english?: string;
  onSend?: (text: string) => void;
}

function Harness({
  initialInput = '',
  original = 'orig prompt',
  refined = 'refined prompt',
  english = 'english prompt',
  onSend = () => {},
}: HarnessProps) {
  // REAL React state — this is what we assert against.
  const [input, setInput] = useState(initialInput);
  const panel = { original, refined, english };

  return (
    <div>
      {/* Observable readout of the live input state. */}
      <div data-testid="input-value">{input}</div>
      <RefinePanel
        original={panel.original}
        refined={panel.refined}
        english={panel.english}
        status="ready"
        onCopyToInput={(copied) => {
          // Mirrors ChatInput.onCopyToInput exactly.
          setInput(copied);
        }}
        onDecision={(decision) => {
          const { original: o, refined: r, english: e } = panel;
          if (decision === 'cancel') {
            // Mirrors ChatInput.onDecision('cancel') exactly, sharing the
            // exported helper so the wiring stays in sync with production.
            setInput((prev) => resolveCancelInput(prev, o));
            return;
          }
          let text = o;
          if (decision === 'refined') text = r;
          else if (decision === 'english') text = e;
          else if (decision === 'edit') {
            setInput(r);
            return;
          }
          // refined / english / original → "send"
          onSend(text);
        }}
      />
    </div>
  );
}

const COPY_TITLE = 'activity:refine.copyToInputTitle';
const readInput = () => screen.getByTestId('input-value').textContent;

// ── Tests ───────────────────────────────────────────────────────────────

describe('ChatInput wiring — onCopyToInput places text into real input state', () => {
  it('copying REFINED sets the input to the refined text and sends nothing', () => {
    const onSend = vi.fn();
    render(<Harness onSend={onSend} />);
    expect(readInput()).toBe('');

    // original / refined / english copy icons in field order.
    const [, refinedCopy] = screen.getAllByTitle(COPY_TITLE);
    fireEvent.click(refinedCopy!);

    expect(readInput()).toBe('refined prompt');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('copying ORIGINAL sets the input to the original text', () => {
    render(<Harness />);
    const [originalCopy] = screen.getAllByTitle(COPY_TITLE);
    fireEvent.click(originalCopy!);
    expect(readInput()).toBe('orig prompt');
  });

  it('copying ENGLISH sets the input to the english text', () => {
    render(<Harness />);
    const [, , englishCopy] = screen.getAllByTitle(COPY_TITLE);
    fireEvent.click(englishCopy!);
    expect(readInput()).toBe('english prompt');
  });

  it('copying overwrites whatever draft was already in the input', () => {
    render(<Harness initialInput="stale draft" />);
    const [, refinedCopy] = screen.getAllByTitle(COPY_TITLE);
    fireEvent.click(refinedCopy!);
    expect(readInput()).toBe('refined prompt');
  });
});

describe('ChatInput wiring — onDecision(cancel) restores/keeps real input state', () => {
  it('cancel with an EMPTY input restores the original prompt', () => {
    const onSend = vi.fn();
    // Simulates the real flow: input was cleared to '' when the panel opened.
    render(<Harness initialInput="" onSend={onSend} />);

    fireEvent.click(screen.getByTitle('activity:refine.cancelTitle'));

    expect(readInput()).toBe('orig prompt');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('cancel KEEPS text the user already copied into the input', () => {
    // Emulate: user clicked a copy icon first (input now holds a version),
    // then re-opened/cancelled. The copied text must survive cancel.
    render(<Harness initialInput="refined prompt" />);

    fireEvent.click(screen.getByTitle('activity:refine.cancelTitle'));

    expect(readInput()).toBe('refined prompt');
  });

  it('cancel with a whitespace-only input still restores the original', () => {
    render(<Harness initialInput="   " />);
    fireEvent.click(screen.getByTitle('activity:refine.cancelTitle'));
    expect(readInput()).toBe('orig prompt');
  });

  it('end-to-end: copy REFINED, then a later cancel keeps the copied text', () => {
    render(<Harness />);
    // 1) Copy refined into the input.
    const [, refinedCopy] = screen.getAllByTitle(COPY_TITLE);
    fireEvent.click(refinedCopy!);
    expect(readInput()).toBe('refined prompt');

    // The panel closed on copy (setRefinePanel(null) in production); here we
    // re-render a fresh panel over the now-populated input to simulate the
    // user opening refine again and cancelling.
    render(<Harness initialInput="refined prompt" />);
    fireEvent.click(screen.getAllByTitle('activity:refine.cancelTitle')[1]!);
    // Both harnesses read the same testid; the second (index 1) is the reopened one.
    expect(screen.getAllByTestId('input-value')[1]!.textContent).toBe('refined prompt');
  });
});

describe('resolveCancelInput — shared source of truth', () => {
  it('restores original when prev is empty', () => {
    expect(resolveCancelInput('', 'orig')).toBe('orig');
  });
  it('restores original when prev is whitespace', () => {
    expect(resolveCancelInput('  \n\t', 'orig')).toBe('orig');
  });
  it('keeps prev when it holds real text', () => {
    expect(resolveCancelInput('copied text', 'orig')).toBe('copied text');
  });
});
