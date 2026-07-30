import path from 'node:path';
import type { EventBus } from '@wrongstack/core/kernel';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  startTerminalTitle: vi.fn(),
}));

vi.mock('../src/terminal-title.js', () => ({
  startTerminalTitle: mocks.startTerminalTitle,
}));

import { createRunTuiTitleController } from '../src/run-tui-title-controller.js';

function options(projectRoot?: string) {
  return {
    stdout: process.stdout,
    events: {} as EventBus,
    model: 'initial-model',
    projectRoot,
  };
}

describe('createRunTuiTitleController', () => {
  it('starts once, tracks the current model, and restarts after disable', () => {
    const firstHandle = { stop: vi.fn(), setModel: vi.fn() };
    const secondHandle = { stop: vi.fn(), setModel: vi.fn() };
    mocks.startTerminalTitle.mockReturnValueOnce(firstHandle).mockReturnValueOnce(secondHandle);
    const projectRoot = path.join('tmp', 'my-project');
    const { controller, start, stop } = createRunTuiTitleController(options(projectRoot));

    controller.setModel('before-start');
    start();
    start();
    expect(mocks.startTerminalTitle).toHaveBeenCalledOnce();
    expect(mocks.startTerminalTitle).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'before-start',
        appName: 'my-project',
      }),
    );

    controller.setModel('after-start');
    expect(firstHandle.setModel).toHaveBeenCalledWith('after-start');

    controller.setEnabled(false);
    expect(firstHandle.stop).toHaveBeenCalledOnce();
    controller.setEnabled(true);
    expect(mocks.startTerminalTitle).toHaveBeenCalledTimes(2);
    expect(mocks.startTerminalTitle).toHaveBeenLastCalledWith(
      expect.objectContaining({ model: 'after-start' }),
    );

    stop();
    expect(secondHandle.stop).toHaveBeenCalledOnce();
  });

  it('omits appName and tolerates an already-torn-down title handle', () => {
    const handle = {
      stop: vi.fn(() => {
        throw new Error('already stopped');
      }),
      setModel: vi.fn(),
    };
    mocks.startTerminalTitle.mockReturnValue(handle);
    const { controller, start, stop } = createRunTuiTitleController(options());

    start();
    expect(mocks.startTerminalTitle).toHaveBeenCalledWith(
      expect.objectContaining({ appName: undefined }),
    );
    expect(() => stop()).not.toThrow();
    expect(() => controller.setEnabled(false)).not.toThrow();
  });
});
