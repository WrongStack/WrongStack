import { render } from 'ink-testing-library';
import type React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppErrorBoundary } from '../src/components/app-error-boundary.js';
import { Text } from '../src/ink.js';

const wait = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('AppErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('replaces a throwing tree with a notice and remounts it on Enter', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    let failing = true;
    let mounts = 0;
    function Flaky(): React.ReactElement {
      if (failing) throw new Error('panel exploded with sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
      mounts += 1;
      return <Text>interface restored</Text>;
    }

    const view = render(
      <AppErrorBoundary>
        <Flaky />
      </AppErrorBoundary>,
    );
    await wait();
    expect(view.lastFrame()).toContain('The interface hit an error and was paused.');
    expect(view.lastFrame()).toContain('panel exploded');
    expect(view.lastFrame()).toContain('Your session and conversation are intact.');
    // The failure reaches the log once, without the credential it quoted.
    const lines = logged.mock.calls.map(([line]) => String(line));
    const record = lines.find((line) => line.includes('app_render_error'));
    expect(record).toBeDefined();
    expect(record).not.toContain('abcdefghijklmnopqrstuvwxyz');

    // Any other key leaves the notice in place.
    view.stdin.write('x');
    await wait();
    expect(view.lastFrame()).toContain('was paused');

    failing = false;
    view.stdin.write('\r');
    await wait();
    expect(view.lastFrame()).toContain('interface restored');
    expect(mounts).toBeGreaterThan(0);
    view.unmount();
  });

  it('shows the notice again when the reloaded tree still throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    function Broken(): React.ReactElement {
      throw new Error('still broken');
    }
    const view = render(
      <AppErrorBoundary>
        <Broken />
      </AppErrorBoundary>,
    );
    await wait();
    view.stdin.write('\r');
    await wait();
    expect(view.lastFrame()).toContain('still broken');
    view.unmount();
  });

  it('renders its children untouched when nothing throws', () => {
    const view = render(
      <AppErrorBoundary>
        <Text>all good</Text>
      </AppErrorBoundary>,
    );
    expect(view.lastFrame()).toBe('all good');
    view.unmount();
  });
});
