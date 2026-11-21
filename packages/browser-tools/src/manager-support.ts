import * as fs from 'node:fs/promises';
import type { BrowserContext, CDPSession, Page } from '@playwright/test';
import { loadPlaywrightRuntime } from './runtime.js';
import type { BrowserConsoleEntry, BrowserFrame, BrowserNetworkEntry } from './types.js';

export interface LiveSession {
  id: string;
  ownerId: string;
  context: BrowserContext;
  page: Page;
  createdAt: string;
  lastUsedAt: string;
  tracing: boolean;
  console: BrowserConsoleEntry[];
  network: BrowserNetworkEntry[];
  conversationId?: string | undefined;
  /** Live viewers of the page, fed by one shared CDP screencast. */
  viewers: Set<(frame: BrowserFrame) => void>;
  screencast?: Promise<CDPSession> | undefined;
}

export async function browserInstallationDiagnostics(): Promise<{
  available: boolean;
  executablePath?: string | undefined;
  message: string;
}> {
  try {
    const { chromium } = await loadPlaywrightRuntime(false);
    const executablePath = chromium.executablePath();
    await fs.access(executablePath);
    return { available: true, executablePath, message: 'Playwright Chromium is available.' };
  } catch {
    return {
      available: false,
      message:
        'Chromium is missing; browser_open installs it automatically. Use /browser install to prepare it now.',
    };
  }
}

/** Reject with `message` when `promise` has not settled within `ms`. */
export function settleWithin<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  // The abandoned evaluation settles (or rejects on page close) later.
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const ESC = String.fromCharCode(27);

const ANSI_SGR = new RegExp(`${ESC}\\[[0-9;]*m`, 'gu');

/**
 * Playwright call logs carry terminal colour codes; they reached the model
 * and the UI as raw `ESC[2m` noise. Keeps the error's name and cause.
 */
export function withoutAnsi(err: unknown): unknown {
  if (!(err instanceof Error) || !err.message.includes(`${ESC}[`)) return err;
  const clean = new Error(err.message.replace(ANSI_SGR, ''), { cause: err });
  clean.name = err.name;
  return clean;
}

export async function startScreencast(session: LiveSession): Promise<CDPSession> {
  const cdp = await session.context.newCDPSession(session.page);
  cdp.on('Page.screencastFrame', (frame) => {
    // Unacknowledged, Chromium stops sending frames.
    void cdp.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => undefined);
    const out: BrowserFrame = {
      data: frame.data,
      width: frame.metadata.deviceWidth,
      height: frame.metadata.deviceHeight,
    };
    for (const viewer of session.viewers) {
      try {
        viewer(out);
      } catch {
        // one viewer's failure must not starve the others
      }
    }
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 60,
    maxWidth: 1280,
    maxHeight: 800,
  });
  return cdp;
}

export function pushBounded<T>(target: T[], value: T, limit: number): void {
  target.push(value);
  if (target.length > limit) target.splice(0, target.length - limit);
}

export async function abortable<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
  onAbort: () => void | Promise<void>,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let aborting = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      fn();
    };
    const abort = () => {
      aborting = true;
      void Promise.resolve(onAbort()).finally(() => {
        finish(() => reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted')));
      });
    };
    signal.addEventListener('abort', abort, { once: true });
    operation().then(
      (value) => {
        if (!aborting) finish(() => resolve(value));
      },
      (err) => {
        if (!aborting) finish(() => reject(err));
      },
    );
  });
}
