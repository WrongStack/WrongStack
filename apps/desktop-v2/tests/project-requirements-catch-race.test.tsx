/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProjectRequirements } from '../src/ProjectRequirements.js';

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

describe('ProjectRequirements sequence-safe load error handling', () => {
  it('drops stale rejection after refreshKey increments while still reporting current errors', async () => {
    let rejectFirst!: (err: unknown) => void;
    let resolveSecond!: (val: unknown) => void;
    let rejectThird!: (err: unknown) => void;
    let call = 0;

    const http = async (path: string) => {
      if (path === '/api/requirement-intakes') {
        call += 1;
        if (call === 1) {
          return new Promise((_res, rej) => {
            rejectFirst = rej;
          });
        }
        if (call === 2) {
          return new Promise((res) => {
            resolveSecond = res;
          });
        }
        return new Promise((_res, rej) => {
          rejectThird = rej;
        });
      }
      return {};
    };

    await act(async () => {
      root!.render(
        <ProjectRequirements
          http={http as never}
          refreshKey={1}
          initialDraft={null}
          onConsumeDraft={() => {}}
        />,
      );
    });

    await act(async () => {
      root!.render(
        <ProjectRequirements
          http={http as never}
          refreshKey={2}
          initialDraft={null}
          onConsumeDraft={() => {}}
        />,
      );
    });

    await act(async () => {
      resolveSecond({ projectId: 'proj-1', intakes: [] });
    });
    await act(async () => {
      rejectFirst(new Error('STALE_LOAD_FAILED'));
    });
    expect(container!.textContent).not.toContain('STALE_LOAD_FAILED');

    await act(async () => {
      root!.render(
        <ProjectRequirements
          http={http as never}
          refreshKey={3}
          initialDraft={null}
          onConsumeDraft={() => {}}
        />,
      );
    });
    await act(async () => {
      rejectThird(new Error('CURRENT_LOAD_FAILED'));
    });
    expect(container!.textContent).toContain('CURRENT_LOAD_FAILED');
  });
});
