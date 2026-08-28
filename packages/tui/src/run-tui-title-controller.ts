import * as path from 'node:path';
import type { EventBus } from '@wrongstack/core/kernel';
import { startTerminalTitle, type TerminalTitleHandle } from './terminal-title.js';

interface RunTuiTitleController {
  setEnabled(on: boolean): void;
  setModel(model: string): void;
}

export function createRunTuiTitleController(opts: {
  stdout: NodeJS.WriteStream;
  events: EventBus;
  model: string;
  projectRoot?: string | undefined;
}): { controller: RunTuiTitleController; start: () => void; stop: () => void } {
  let titleHandle: TerminalTitleHandle | null = null;
  let currentModel = opts.model;
  const start = () => {
    if (titleHandle) return;
    titleHandle = startTerminalTitle({
      stdout: opts.stdout,
      events: opts.events,
      model: currentModel,
      appName: opts.projectRoot ? path.basename(opts.projectRoot) : undefined,
    });
  };
  const stop = () => {
    try {
      titleHandle?.stop();
    } catch {
      // title controller already torn down - ignore.
    }
    titleHandle = null;
  };
  return {
    controller: {
      setEnabled(on: boolean) {
        if (on) start();
        else stop();
      },
      setModel(model: string) {
        currentModel = model;
        titleHandle?.setModel(model);
      },
    },
    start,
    stop,
  };
}
