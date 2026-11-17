/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SandboxChip } from '../src/SandboxChip.js';

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

describe('SandboxChip poll sequence guard', () => {
  it('keeps fresh-tier when poll 1 resolves late', async () => {
    let resolvePoll1!: (v: unknown) => void;
    let resolvePoll2!: (v: unknown) => void;
    let calls = 0;

    const http = async () => {
      calls += 1;
      if (calls === 1) {
        return new Promise((r) => {
          resolvePoll1 = r;
        });
      }
      return new Promise((r) => {
        resolvePoll2 = r;
      });
    };

    await act(async () => {
      root!.render(<SandboxChip sessionId="s1" http={http as never} pollMs={15} />);
    });
    await new Promise((r) => setTimeout(r, 25));

    await act(async () => {
      resolvePoll2({ sandbox: { mode: 'enforced', tier: 'fresh-tier', backend: 'seatbelt' } });
    });
    await act(async () => {
      resolvePoll1({ sandbox: { mode: 'enforced', tier: 'stale-tier', backend: 'seatbelt' } });
    });

    const title =
      container!.querySelector('[data-testid="sandbox-status"]')?.getAttribute('title') ?? '';
    expect(title).toContain('fresh-tier');
    expect(title).not.toContain('stale-tier');
  });
});
