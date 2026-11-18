// @vitest-environment jsdom
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { RuntimeGate } from '../src/RuntimeGate';

const request = vi.hoisted(() => vi.fn());
vi.mock('../src/platform', () => ({ request }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it.each(['starting', 'running', 'error'])(
  'reads the new project status before committing its page when the old gate is %s',
  async (oldStatus) => {
    const oldResult = Promise.withResolvers<{ status: string }>();
    const newResult = Promise.withResolvers<{ status: string }>();
    request.mockReset().mockImplementation(async (method, { projectId }) => {
      if (method === 'project.open') return;
      if (projectId === 'new') return newResult.promise;
      if (oldStatus === 'starting') return oldResult.promise;
      return { status: oldStatus };
    });
    const commits: string[] = [];
    function Page({ id }: { id: string }) {
      useLayoutEffect(() => {
        commits.push(id);
      }, [id]);
      return createElement('p', null, id);
    }

    const host = document.createElement('div');
    const root = createRoot(host);
    const render = (projectId: string) =>
      act(async () =>
        root.render(
          createElement(RuntimeGate, {
            scope: 'project',
            projectId,
            children: createElement(Page, { id: projectId }),
          }),
        ),
      );
    const expected = oldStatus === 'running' ? ['old'] : [];
    try {
      await render('old');
      expect(commits).toEqual(expected);
      await render('new');
      expect(commits).toEqual(expected);
      await act(async () => oldResult.resolve({ status: 'running' }));
      expect(commits).toEqual(expected);
      expect(host.querySelector('[role="alert"]')).toBeNull();
      await act(async () => newResult.resolve({ status: 'running' }));
      expect(commits).toEqual([...expected, 'new']);
    } finally {
      await act(async () => root.unmount());
    }
  },
);
