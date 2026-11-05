import type { SessionStore } from '@wrongstack/contracts/types';

/**
 * What the portable slash commands need from the process running them. The TUI passes its
 * whole command context, which has every field; an engine without a terminal passes these.
 */
export interface SessionCommandHost {
  sessionStore?: SessionStore | undefined;
}

/** Where a command reports progress while it runs, besides its returned message. */
export interface CommandNotices {
  write(text: string): void;
  writeInfo(text: string): void;
  writeWarning(text: string): void;
}

export interface InitCommandHost {
  projectRoot: string;
  renderer: CommandNotices;
}

export interface PortableCommandHost extends SessionCommandHost, InitCommandHost {}
