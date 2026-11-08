import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Browser } from '@playwright/test';
import { attachToolImages } from '@wrongstack/contracts/types';
import { MAX_INCOMING_IMAGE_BYTES, ulid } from '@wrongstack/core/utils';
import type { BrowserElementSelection } from '@wrongstack/primitives';
import { BrowserArtifactStore } from './artifacts.js';
import type { LiveSession } from './manager-support.js';
import {
  abortable,
  pushBounded,
  settleWithin,
  startScreencast,
  withoutAnsi,
} from './manager-support.js';
import { BrowserNetworkGuardProxy } from './network-guard-proxy.js';
import { boundBrowserSelection, browserPointExpression } from './pick.js';
import { launchBrowserRuntime } from './runtime.js';
import { assertBrowserUrlAllowed, redactBrowserText, safeBrowserUrl } from './security.js';
import type {
  BrowserArtifact,
  BrowserFrame,
  BrowserLiveDetails,
  BrowserLiveSummary,
  BrowserManagerOptions,
  BrowserNetworkEntry,
  BrowserOpenOptions,
  BrowserSessionSummary,
  BrowserSnapshot,
} from './types.js';

export { browserInstallationDiagnostics } from './manager-support.js';

const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_SNAPSHOT_CHARS = 64 * 1024;
const DEFAULT_MAX_ENTRIES = 100;

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
  /** open() calls that may hold the shared browser without a registered session yet. */
  private openers = 0;

  constructor(
    options: BrowserManagerOptions,
    private readonly launcher: BrowserLauncher = launchBrowserRuntime,
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
    // Concurrent openers share one browser. Until an opener has registered its
    // session it holds the browser without being counted in `sessions`, so any
    // other opener's failure or abort must not reclaim it from under them.
    this.openers++;
    try {
      return await this.openSession(ownerId, input, signal);
    } finally {
      this.openers--;
      await this.closeBrowserIfIdle();
    }
  }

  private async openSession(
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
      conversationId: input.conversationId,
      viewers: new Set(),
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
        } catch (error) {
          this.pushNetwork(session, {
            method: route.request().method(),
            url: safeBrowserUrl(route.request().url()),
            failed: true,
            error: redactBrowserText(error instanceof Error ? error.message : String(error)),
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
    beforeNavigation?: (() => Promise<void>) | undefined,
  ): Promise<BrowserSessionSummary> {
    const session = this.requireOwned(id, ownerId);
    await beforeNavigation?.();
    await assertBrowserUrlAllowed(rawUrl, {
      allowPrivateHosts: this.allowPrivateHosts,
      allowedPrivateOrigins: this.allowedPrivateOrigins,
      navigation: true,
    });
    await this.runPageOperation(session, signal, () =>
      session.page.goto(rawUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.operationTimeoutMs,
      }),
    );
    // Only the requested URL is checked above. A redirect to a blocked
    // address is refused by the network proxy with a 403 page, so `goto`
    // still resolved and the tool reported success with the blocked
    // address as the session URL.
    const landed = session.page.url();
    try {
      await assertBrowserUrlAllowed(landed, {
        allowPrivateHosts: this.allowPrivateHosts,
        allowedPrivateOrigins: this.allowedPrivateOrigins,
        navigation: true,
      });
    } catch (error) {
      await this.runPageOperation(session, signal, () => session.page.goto('about:blank'));
      throw new Error(
        `browser: navigation was redirected to a blocked address (${safeBrowserUrl(landed)}). ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
        // biome-ignore lint/performance/useDomNodeTextContent: Playwright's rendered text, not the DOM property; textContent() would add hidden and script text
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
    const artifact = await this.artifacts.write(
      session.id,
      'screenshot',
      'png',
      'image/png',
      bytes,
    );
    if (bytes.byteLength > 0 && bytes.byteLength <= MAX_INCOMING_IMAGE_BYTES) {
      attachToolImages(artifact, [
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: Buffer.from(bytes).toString('base64'),
          },
        },
      ]);
    }
    return artifact;
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
      // Canonical escape test (same predicate as paths.ts escapesRoot /
      // _util.ts isInsideAny): a legal in-root first segment like `..uploads`
      // yields a relative path that a bare startsWith('..') misreads as a
      // parent traversal and wrongly rejects.
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
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
      // Same canonical escape test as the lexical check above, applied to the
      // symlink-resolved real path: an in-root real target under a
      // ..-prefixed directory is legal, not an escape.
      if (
        realRelative === '..' ||
        realRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(realRelative)
      ) {
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
    // page.evaluate has no timeout of its own: an expression that never
    // settles held the call until the host's iteration timeout.
    const result = await this.runPageOperation(session, signal, () =>
      settleWithin(
        session.page.evaluate(expression),
        this.operationTimeoutMs,
        `browser: evaluation did not settle within ${this.operationTimeoutMs}ms`,
      ),
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

  /** Every open session, whoever owns it: the WebUI's live view lists them. */
  async liveSessions(): Promise<BrowserLiveSummary[]> {
    return Promise.all(
      [...this.sessions.values()].map(async (session) => ({
        ...(await this.summary(session)),
        ...(session.conversationId ? { conversationId: session.conversationId } : {}),
      })),
    );
  }

  /** URL, title and the recent console and network entries, or undefined once closed. */
  async liveDetails(id: string, limit: number): Promise<BrowserLiveDetails | undefined> {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    const { url, title } = await this.summary(session);
    return {
      url,
      title,
      console: session.console.slice(-limit).map((entry) => ({ ...entry })),
      network: session.network.slice(-limit).map((entry) => ({ ...entry })),
    };
  }

  async pickElement(
    id: string,
    conversationId: string,
    point: { x: number; y: number; url: string },
  ): Promise<BrowserElementSelection> {
    const session = this.sessions.get(id);
    if (!session || !conversationId || session.conversationId !== conversationId)
      throw new Error('Browser session is not open in this conversation');
    const expression = browserPointExpression(point.x, point.y);
    const url = safeBrowserUrl(session.page.url());
    if (url !== point.url)
      throw new Error('The browser navigated; wait for a current frame and select again');
    const selected = boundBrowserSelection(
      await this.evaluate(id, session.ownerId, expression, new AbortController().signal),
    );
    const { bounds, viewport } = selected;
    const x = Math.max(0, bounds.x),
      y = Math.max(0, bounds.y);
    const width = Math.min(1024, viewport.width - x, bounds.x + bounds.width - x);
    const height = Math.min(768, viewport.height - y, bounds.y + bounds.height - y);
    let image: BrowserElementSelection['image'];
    if (width >= 1 && height >= 1) {
      const bytes = await session.page.screenshot({
        type: 'jpeg',
        quality: 65,
        clip: { x, y, width, height },
        timeout: this.operationTimeoutMs,
      });
      if (bytes.byteLength <= 1024 * 1024)
        image = { data: bytes.toString('base64'), mimeType: 'image/jpeg', width, height };
    }
    const title = redactBrowserText((await session.page.title()).slice(0, 300));
    if (safeBrowserUrl(session.page.url()) !== url)
      throw new Error('The browser navigated during inspection; select again');
    return {
      ...selected,
      browserId: id,
      ownerId: session.ownerId,
      text: redactBrowserText(selected.text),
      selector: selected.selector,
      url,
      title,
      capturedAt: new Date().toISOString(),
      ...(image ? { image } : {}),
    };
  }

  /**
   * Watch a session's page. Frames come from a CDP screencast, which sends
   * one when the page changes (and one to start); every viewer of a session
   * shares it, and it stops with the last viewer. Read-only: nothing a viewer
   * does reaches the page.
   */
  async watch(id: string, viewer: (frame: BrowserFrame) => void): Promise<() => Promise<void>> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`browser session ${id} is not open`);
    session.viewers.add(viewer);
    session.screencast ??= startScreencast(session);
    try {
      await session.screencast;
    } catch (err) {
      session.viewers.delete(viewer);
      if (session.viewers.size === 0) session.screencast = undefined;
      throw err;
    }
    return async () => {
      session.viewers.delete(viewer);
      if (session.viewers.size > 0 || !session.screencast) return;
      const cast = session.screencast;
      session.screencast = undefined;
      const cdp = await cast.catch(() => undefined);
      await cdp?.send('Page.stopScreencast').catch(() => undefined);
      await cdp?.detach().catch(() => undefined);
    };
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
          // Wait for the launch to land so a late browser is not orphaned, but
          // do not close it here: other openers may share it. open() reclaims
          // an idle browser once the last opener has finished.
          await this.launching?.catch(() => undefined);
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
    }).catch((err: unknown) => {
      throw withoutAnsi(err);
    });
  }

  private async closeBrowserIfIdle(): Promise<void> {
    if (this.sessions.size > 0 || this.openers > 0 || !this.browser) return;
    const browser = this.browser;
    this.browser = undefined;
    await browser.close().catch(() => undefined);
  }
}
