/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CouncilDecisionCard } from '../src/council/CouncilDecisionCard.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

describe('CouncilDecisionCard Rules of Hooks stability', () => {
  it('transitions cleanly between null and parsed decision without hook order errors', async () => {
    const decision = {
      requestId: 'req-1',
      phase: 'resolved' as const,
      status: 'decided' as const,
      resolution: 'decided' as const,
      question: 'Ship?',
      reason: 'All clear',
      seats: [
        {
          seatId: 's1',
          at: 0,
          persona: 'Critic',
          status: 'valid' as const,
          optionId: 'approve',
          weight: 1,
        },
      ],
    };

    await act(async () => {
      root!.render(<CouncilDecisionCard content="" />);
    });
    expect(container!.innerHTML).toBe('');

    await act(async () => {
      root!.render(<CouncilDecisionCard decision={decision} />);
    });
    expect(container!.textContent).toContain('Ship?');

    await act(async () => {
      root!.render(<CouncilDecisionCard content="" />);
    });
    expect(container!.innerHTML).toBe('');
  });
});
