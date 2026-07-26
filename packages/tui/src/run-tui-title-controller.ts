import * as path from 'node:path';
import type { EventBus } from '@wrongstack/core/kernel';
import { startTerminalTitle } from './terminal-title.js';

export interface RunTuiTitleController {
  setEnabled(on: boolean): void;
}

export function createRunTuiTitleController(opts: {
  stdout: NodeJS.WriteStream;
  events: EventBus;
  model: string;
  projectRoot?: string | undefined;
}): { controller: RunTuiTitleController; start: () => void; stop: () => void } {
  let titleStop: (() => void) | null = null;
  const start = () => {
    if (titleStop) return;
    titleStop = startTerminalTitle({
      stdout: opts.stdout,
      events: opts.events,
      model: opts.model,
      appName: opts.projectRoot ? path.basename(opts.projectRoot) : undefined,
    });
  };
  const stop = () => {
    try {
      titleStop?.();
    } catch {
      // title controller already torn down - ignore.
    }
    titleStop = null;
  };
  return {
    controller: {
      setEnabled(on: boolean) {
        if (on) start();
        else stop();
      },
    },
    start,
    stop,
  };
}
