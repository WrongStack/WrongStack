import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import { ulid } from '@wrongstack/core/utils';
import { BrowserArtifactStore } from './artifacts.js';
import { BrowserNetworkGuardProxy } from './network-guard-proxy.js';
import { assertBrowserUrlAllowed, redactBrowserText, safeBrowserUrl } from './security.js';
import type {
  BrowserArtifact,
  BrowserConsoleEntry,
  BrowserManagerOptions,
  BrowserNetworkEntry,
  BrowserOpenOptions,
  BrowserSessionSummary,
  BrowserSnapshot,
} from './types.js';

const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_SNAPSHOT_CHARS = 64 * 1024;
const DEFAULT_MAX_ENTRIES = 100;

interface LiveSession {
  id: string;
  ownerId: string;
  context: BrowserContext;
  page: Page;
  createdAt: string;
  lastUsedAt: string;
  tracing: boolean;
  console: BrowserConsoleEntry[];
  network: BrowserNetworkEntry[];
}

export type BrowserLauncher = (headless: boolean) => Promise<Browser>;

export class BrowserSessionManager {
  private readonly sessions = new Map<string, LiveSession>();
  private readonly artifacts: BrowserArtifactStore;
  private readonly allowPrivateHosts: boolean;
  private readonly allowedPrivateOrigins: readonly string[];
  private readonly networkProxy: BrowserNetworkGuardProxy;
  private readonly headless: boolean;
  private readonly operationTimeoutMs: number;
  private readonly maxSnapshotChars: number;
  private readonly maxConsoleEntries: number;
  private readonly maxNetworkEntries: number;
  private browser?: Browser | undefined;
  private launching?: Promise<Browser> | undefined;

  constructor(
    options: BrowserManagerOptions,
    private readonly launcher: BrowserLauncher = defaultLauncher,
  ) {
    this.artifacts = new BrowserArtifactStore(options.artifactRoot);
    // Default closed: this flag short-circuits the navigation check, the subresource
    // route check, and resolvePinnedBrowserTarget. The production wiring never passed
    // it, so the documented private/loopback/link-local block was inert (WS-074).
    this.allowPrivateHosts = options.allowPrivateHosts ?? false;
    this.allowedPrivateOrigins = options.allowedPrivateOrigins ?? [];
    this.networkProxy = new BrowserNetworkGuardProxy({
      allowPrivateHosts: this.allowPrivateHosts,
      allowedPrivateOrigins: this.allowedPrivateOrigins,
    });
    this.headless = options.headless ?? true;
    this.operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    this.maxSnapshotChars = options.maxSnapshotChars ?? DEFAULT_MAX_SNAPSHOT_CHARS;
    this.maxConsoleEntries = options.maxConsoleEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxNetworkEntries = options.maxNetworkEntries ?? DEFAULT_MAX_ENTRIES;
  }

  async open(
    ownerId: string,
    input: BrowserOpenOptions,
    signal: AbortSignal,
  ): Promise<BrowserSessionSummary> {
    signal.throwIfAborted();
    if (input.url) {
      await assertBrowserUrlAllowed(input.url, {
        allowPrivateHosts: this.allowPrivateHosts,
        allowedPrivateOrigins: this.allowedPrivateOrigins,
        navigation: true,
      });
    }
    const browser = await this.ensureBrowser(signal);
    const proxyServer = await this.networkProxy.start();
    const context = await abortable(
      signal,
      async () => {
        const created = await browser.newContext({
          acceptDownloads: false,
          ignoreHTTPSErrors: false,
          serviceWorkers: 'block',
          proxy: { server: proxyServer },
          viewport: input.viewport ?? { width: 1440, height: 900 },
        });
        if (signal.aborted) {
          await created.close().catch(() => undefined);
          signal.throwIfAborted();
        }
        return created;
      },
      () => undefined,
    );
    const page = await context.newPage().catch(async (error) => {
      // newPage() runs outside the session-facing try/catch below (it is
      // part of the session literal). A failure here would otherwise leak
      // the freshly created BrowserContext — a full renderer process — until
      // dispose(). Close it and reclaim the idle browser before propagating.
      await context.close().catch(() => undefined);
      await this.closeBrowserIfIdle();
      throw error;
    });
    const session: LiveSession = {
      id: ulid(),
      ownerId,
      context,
      page,
      createdAt: new Date().toISOString(),
      lastUsedAt: new Date().toISOString(),
      tracing: input.trace ?? true,
      console: [],
      network: [],
    };
    this.sessions.set(session.id, session);
    this.attachEvidenceCollectors(session);
    try {
      await context.route('**/*', async (route) => {
        try {
          await assertBrowserUrlAllowed(route.request().url(), {
            allowPrivateHosts: this.allowPrivateHosts,
            allowedPrivateOrigins: this.allowedPrivateOrigins,
            navigation: false,
          });
          await route.continue();
        } catch {
          this.pushNetwork(session, {
            method: route.request().method(),
            url: safeBrowserUrl(route.request().url()),
            failed: true,
            at: new Date().toISOString(),
          });
          await route.abort('blockedbyclient');
        }
      });
      if (session.tracing) {
        await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
      }
      if (input.url) await this.navigate(session.id, ownerId, input.url, signal);
      return await this.summary(session);
    } catch (err) {
      await context.close().catch(() => undefined);
      this.sessions.delete(session.id);
      await this.closeBrowserIfIdle();
      throw err;
    }
  }

  async list(ownerId: string): Promise<BrowserSessionSummary[]> {
    const owned = [...this.sessions.values()].filter((session) => session.ownerId === ownerId);
    return Promise.all(owned.map((session) => this.summary(session)));
  }

  async navigate(
    id: string,
    ownerId: string,
    rawUrl: string,
    signal: AbortSignal,
  ): Promise<BrowserSessionSummary> {
    await assertBrowserUrlAllowed(rawUrl, {
      allowPrivateHosts: this.allowPrivateHosts,
      allowedPrivateOrigins: this.allowedPrivateOrigins,
      navigation: true,
    });
    const session = this.requireOwned(id, ownerId);
    await this.runPageOperation(session, signal, () =>
      session.page.goto(rawUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.operationTimeoutMs,
      }),
    );
    return this.summary(session);
  }

  async snapshot(id: string, ownerId: string, signal: AbortSignal): Promise<BrowserSnapshot> {
    const session = this.requireOwned(id, ownerId);
    const raw = await this.runPageOperation(session, signal, async () => {
      try {
        return await session.page
          .locator('body')
          .ariaSnapshot({ timeout: this.operationTimeoutMs });
      } catch {
        return await session.page.locator('body').innerText({ timeout: this.operationTimeoutMs });
      }
    });
    const aria = redactBrowserText(raw);
    const truncated = aria.length > this.maxSnapshotChars;
    return {
      session: await this.summary(session),
      aria: truncated ? `${aria.slice(0, this.maxSnapshotChars)}\n…[snapshot truncated]` : aria,
      console: session.console.map((entry) => ({ ...entry })),
      network: session.network.map((entry) => ({ ...entry })),
      truncated,
    };
  }

  async screenshot(
    id: string,
    ownerId: string,
    input: { fullPage?: boolean | undefined; selector?: string | undefined },
    signal: AbortSignal,
  ): Promise<BrowserArtifact> {
    const session = this.requireOwned(id, ownerId);
    const bytes = await this.runPageOperation(session, signal, () =>
      input.selector
        ? session.page
            .locator(input.selector)
            .screenshot({ type: 'png', timeout: this.operationTimeoutMs })
        : session.page.screenshot({ type: 'png', fullPage: input.fullPage ?? false }),
    );
    signal.throwIfAborted();
    return this.artifacts.write(session.id, 'screenshot', 'png', 'image/png', bytes);
  }

  async click(id: string, ownerId: string, selector: string, signal: AbortSignal): Promise<void> {
    const session = this.requireOwned(id, ownerId);
    await this.runPageOperation(session, signal, () =>
      session.page.locator(selector).click({ timeout: this.operationTimeoutMs }),
    );
  }

  async type(
    id: string,
    ownerId: string,
    selector: string,
    text: string,
    signal: AbortSignal,
  ): Promise<void> {
    const session = this.requireOwned(id, ownerId);
    await this.runPageOperation(session, signal, () =>
      session.page.locator(selector).fill(text, { timeout: this.operationTimeoutMs }),
    );
  }

  async select(
    id: string,
    ownerId: string,
    selector: string,
    value: string,
    signal: AbortSignal,
  ): Promise<void> {
    const session = this.requireOwned(id, ownerId);
    await this.runPageOperation(session, signal, () =>
      session.page.locator(selector).selectOption(value, { timeout: this.operationTimeoutMs }),
    );
  }

  async press(id: string, ownerId: string, key: string, signal: AbortSignal): Promise<void> {
    const session = this.requireOwned(id, ownerId);
    await this.runPageOperation(session, signal, () => session.page.keyboard.press(key));
  }

  async hover(id: string, ownerId: string, selector: string, signal: AbortSignal): Promise<void> {
    const session = this.requireOwned(id, ownerId);
    await this.runPageOperation(session, signal, () =>
      session.page.locator(selector).hover({ timeout: this.operationTimeoutMs }),
    );
  }

  async wait(
    id: string,
    ownerId: string,
    input: { selector?: string | undefined; timeoutMs?: number | undefined },
    signal: AbortSignal,
  ): Promise<void> {
    const session = this.requireOwned(id, ownerId);
    const timeout = Math.min(
      Math.max(input.timeoutMs ?? this.operationTimeoutMs, 0),
      this.operationTimeoutMs,
    );
    await this.runPageOperation(session, signal, () =>
      input.selector
        ? session.page.locator(input.selector).waitFor({ state: 'visible', timeout })
        : session.page.waitForTimeout(timeout),
    );
  }

  async drag(
    id: string,
    ownerId: string,
    from: string,
    to: string,
    signal: AbortSignal,
  ): Promise<void> {
    const session = this.requireOwned(id, ownerId);
    await this.runPageOperation(session, signal, () =>
      session.page.locator(from).dragTo(session.page.locator(to), {
        timeout: this.operationTimeoutMs,
      }),
    );
  }

  async upload(
    id: string,
    ownerId: string,
    selector: string,
    files: string[],
    projectRoot: string,
    signal: AbortSignal,
  ): Promise<void> {
    const session = this.requireOwned(id, ownerId);
    const root = path.resolve(projectRoot);
    const realRoot = await fs.realpath(root);
    const resolved: string[] = [];
    for (const file of files) {
      const absolute = path.resolve(root, file);
      const relative = path.relative(root, absolute);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('browser: upload files must stay inside the project root');
      }
      let realFile: string;
      try {
        realFile = await fs.realpath(absolute);
      } catch (error) {
        // A raw ENOENT here surfaced as an opaque errno; report it in the
        // tool's own error style like the other upload validations.
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
          throw new Error(`browser: upload file not found: ${file}`);
        }
        throw error;
      }
      const realRelative = path.relative(realRoot, realFile);
      if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
        throw new Error('browser: upload files must not escape the project root through a symlink');
      }
      const stat = await fs.stat(realFile);
      if (!stat.isFile()) throw new Error(`browser: upload target is not a file: ${file}`);
      resolved.push(realFile);
    }
    await this.runPageOperation(session, signal, () =>
      session.page.locator(selector).setInputFiles(resolved, { timeout: this.operationTimeoutMs }),
    );
  }

  async evaluate(
    id: string,
    ownerId: string,
    expression: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const session = this.requireOwned(id, ownerId);
    const result = await this.runPageOperation(session, signal, () =>
      session.page.evaluate(expression),
    );
    const serialized = JSON.stringify(result);
    if (serialized && serialized.length > this.maxSnapshotChars) {
      throw new Error(`browser: evaluation result exceeds ${this.maxSnapshotChars} characters`);
    }
    return result;
  }

  async close(id: string, ownerId: string): Promise<{ trace?: BrowserArtifact | undefined }> {
    const session = this.requireOwned(id, ownerId);
    let trace: BrowserArtifact | undefined;
    try {
      if (session.tracing) {
        const target = this.artifacts.pathFor(session.id, 'zip');
        await fs.mkdir(path.dirname(target.path), { recursive: true });
        await session.context.tracing.stop({ path: target.path });
        trace = await this.artifacts.describe(target.id, 'trace', target.path, 'application/zip');
      }
    } finally {
      await session.context.close().catch(() => undefined);
      this.sessions.delete(id);
      await this.closeBrowserIfIdle();
    }
    return trace ? { trace } : {};
  }

  async closeOwner(ownerId: string): Promise<void> {
    const ids = [...this.sessions.values()]
      .filter((session) => session.ownerId === ownerId)
      .map((session) => session.id);
    for (const id of ids) await this.close(id, ownerId).catch(() => undefined);
  }

  /** True when the manager owns no live browser contexts. */
  isIdle(): boolean {
    return this.sessions.size === 0;
  }

  async dispose(): Promise<void> {
    for (const session of [...this.sessions.values()]) {
      await session.context.close().catch(() => undefined);
    }
    this.sessions.clear();
    const browser = this.browser;
    this.browser = undefined;
    this.launching = undefined;
    await browser?.close().catch(() => undefined);
    await this.networkProxy.close();
  }

  private async ensureBrowser(signal: AbortSignal): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.launching) {
      this.launching = this.launcher(this.headless).then((browser) => {
        this.browser = browser;
        browser.on('disconnected', () => {
          if (this.browser === browser) this.browser = undefined;
          for (const [id, session] of this.sessions) {
            if (session.context.browser() === browser) this.sessions.delete(id);
          }
        });
        return browser;
      });
    }
    try {
      return await abortable(
        signal,
        () => this.launching!,
        async () => {
          const browser = await this.launching?.catch(() => undefined);
          await browser?.close().catch(() => undefined);
        },
      );
    } finally {
      this.launching = undefined;
    }
  }

  private requireOwned(id: string, ownerId: string): LiveSession {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`browser: unknown session "${id}"`);
    if (session.ownerId !== ownerId) throw new Error('browser: session belongs to another agent');
    session.lastUsedAt = new Date().toISOString();
    return session;
  }

  private async summary(session: LiveSession): Promise<BrowserSessionSummary> {
    return {
      id: session.id,
      ownerId: session.ownerId,
      url: safeBrowserUrl(session.page.url()),
      title: redactBrowserText(await session.page.title().catch(() => '')),
      createdAt: session.createdAt,
      lastUsedAt: session.lastUsedAt,
      tracing: session.tracing,
    };
  }

  private attachEvidenceCollectors(session: LiveSession): void {
    session.page.on('console', (message) => {
      pushBounded(
        session.console,
        {
          level: message.type(),
          text: redactBrowserText(message.text()).slice(0, 4_096),
          at: new Date().toISOString(),
        },
        this.maxConsoleEntries,
      );
    });
    session.page.on('response', (response) => {
      this.pushNetwork(session, {
        method: response.request().method(),
        url: safeBrowserUrl(response.url()),
        status: response.status(),
        at: new Date().toISOString(),
      });
    });
    session.page.on('requestfailed', (request) => {
      this.pushNetwork(session, {
        method: request.method(),
        url: safeBrowserUrl(request.url()),
        failed: true,
        at: new Date().toISOString(),
      });
    });
  }

  private pushNetwork(session: LiveSession, entry: BrowserNetworkEntry): void {
    pushBounded(session.network, entry, this.maxNetworkEntries);
  }

  private async runPageOperation<T>(
    session: LiveSession,
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> {
    signal.throwIfAborted();
    session.lastUsedAt = new Date().toISOString();
    return abortable(signal, operation, async () => {
      await session.context.close().catch(() => undefined);
      this.sessions.delete(session.id);
      await this.closeBrowserIfIdle();
    });
  }

  private async closeBrowserIfIdle(): Promise<void> {
    if (this.sessions.size > 0 || !this.browser) return;
    const browser = this.browser;
    this.browser = undefined;
    await browser.close().catch(() => undefined);
  }
}

async function defaultLauncher(headless: boolean): Promise<Browser> {
  try {
    const { chromium } = await import('@playwright/test');
    return await chromium.launch({ headless });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `browser: Playwright Chromium is unavailable (${detail}). Run "pnpm exec playwright install chromium".`,
    );
  }
}

export async function browserInstallationDiagnostics(): Promise<{
  available: boolean;
  executablePath?: string | undefined;
  message: string;
}> {
  try {
    const { chromium } = await import('@playwright/test');
    const executablePath = chromium.executablePath();
    await fs.access(executablePath);
    return { available: true, executablePath, message: 'Playwright Chromium is available.' };
  } catch {
    return {
      available: false,
      message: 'Playwright Chromium is unavailable. Run "pnpm exec playwright install chromium".',
    };
  }
}

function pushBounded<T>(target: T[], value: T, limit: number): void {
  target.push(value);
  if (target.length > limit) target.splice(0, target.length - limit);
}

async function abortable<T>(
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
