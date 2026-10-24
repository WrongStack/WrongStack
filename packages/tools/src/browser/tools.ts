import * as path from 'node:path';
import type { Tool } from '@wrongstack/contracts/types';
import type { Context } from '@wrongstack/core/agent';
import { ToolCapabilities } from '@wrongstack/core/security';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { createLiveBrowserAccess } from './live-access.js';
import { BrowserSessionManager, browserInstallationDiagnostics } from './manager.js';
import { browserPrivateOrigins } from './policy.js';
import { promptForPrivateOrigin } from './private-origin-prompt.js';

const managers = new Map<string, BrowserSessionManager>();
const cleanupSignalByContext = new WeakMap<object, AbortSignal>();

function signalFor(ctx: Context, opts?: { signal?: AbortSignal }): AbortSignal {
  return opts?.signal ?? ctx.signal ?? new AbortController().signal;
}

/**
 * The project's browser manager. Exported for in-package tools (design
 * reference extraction) that must run under the same network guard, private
 * origin policy and run-abort cleanup as the browser_* tools.
 */
export function managerFor(ctx: Context): BrowserSessionManager {
  const root = path.resolve(ctx.projectRoot ?? ctx.cwd ?? process.cwd());
  // Called on every tool call, not only at manager creation: it re-reads the
  // policy file when another process changed it, in place in the live array
  // the manager and its proxy already hold.
  const allowedPrivateOrigins = browserPrivateOrigins(root);
  let manager = managers.get(root);
  if (!manager) {
    const wpaths = resolveWstackPaths({ projectRoot: root });
    manager = new BrowserSessionManager({
      artifactRoot: path.join(wpaths.projectDir, 'browser-artifacts'),
      allowedPrivateOrigins,
    });
    managers.set(root, manager);
  }
  const runSignal = ctx.signal;
  if (runSignal && cleanupSignalByContext.get(ctx) !== runSignal) {
    cleanupSignalByContext.set(ctx, runSignal);
    const managerForRun = manager;
    const rootForRun = root;
    const ownerForRun = owner(ctx);
    ctx.registerAbortHook?.(async () => {
      if (cleanupSignalByContext.get(ctx) === runSignal) {
        cleanupSignalByContext.delete(ctx);
      }
      await managerForRun.closeOwner(ownerForRun);
      // Managers are keyed by project root and own a listening network proxy.
      // Drop the entry as soon as the final owner is gone so project switching
      // cannot accumulate one proxy/server handle per visited repository.
      if (managerForRun.isIdle() && managers.get(rootForRun) === managerForRun) {
        managers.delete(rootForRun);
        await managerForRun.dispose();
      }
    });
  }
  return manager;
}

/**
 * The WebUI's read-only live view of the agent's browser, by project root.
 * No manager (nothing opened a browser in that project yet) means no sessions.
 */
export const liveBrowser = createLiveBrowserAccess((root) => managers.get(path.resolve(root)));

export function owner(ctx: Context): string {
  return ctx.agentId || 'leader';
}

function json(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

const sessionIdSchema = {
  type: 'string',
  minLength: 1,
  description: 'Browser session id returned by browser_open.',
} as const;

export interface BrowserOpenInput {
  url?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  trace?: boolean | undefined;
}

export interface BrowserNavigateInput {
  sessionId: string;
  url: string;
}

export interface BrowserSnapshotInput {
  sessionId: string;
}

export interface BrowserScreenshotInput {
  sessionId: string;
  fullPage?: boolean | undefined;
  selector?: string | undefined;
}

export interface BrowserSelectorInput {
  sessionId: string;
  selector: string;
}

export interface BrowserTypeInput extends BrowserSelectorInput {
  text?: string | undefined;
  secretEnv?: string | undefined;
}

export interface BrowserSelectInput extends BrowserSelectorInput {
  value: string;
}

export interface BrowserPressInput {
  sessionId: string;
  key: string;
}

export interface BrowserDragInput {
  sessionId: string;
  from: string;
  to: string;
}

export interface BrowserWaitInput {
  sessionId: string;
  selector?: string | undefined;
  timeoutMs?: number | undefined;
}

export interface BrowserEvaluateInput {
  sessionId: string;
  expression: string;
}

export interface BrowserUploadInput extends BrowserSelectorInput {
  files: string[];
}

export interface BrowserCloseInput {
  sessionId: string;
}

export const browserOpenTool: Tool<BrowserOpenInput> = {
  name: 'browser_open',
  // Package and browser downloads each have a three-minute subprocess limit;
  // the default one-minute executor ceiling would abort first-use setup.
  timeoutMs: 420_000,
  managesOwnTimeout: true,
  description:
    'Open an isolated first-party Playwright browser session, optionally navigating to a URL. ' +
    'Allow a private/localhost origin for this project with /browser allow <origin>, or WRONGSTACK_BROWSER_PRIVATE_ORIGINS. Missing Playwright/Chromium is installed automatically.',
  usageHint: 'browser_open({ url?, width?, height?, trace? })',
  permission: 'confirm',
  mutating: true,
  riskTier: 'standard',
  capabilities: [ToolCapabilities.NET_OUTBOUND],
  subjectKey: 'url',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Optional absolute http(s) URL.' },
      width: { type: 'integer', minimum: 320, maximum: 3840 },
      height: { type: 'integer', minimum: 240, maximum: 2160 },
      trace: { type: 'boolean', description: 'Capture a Playwright trace; defaults to true.' },
    },
  },
  async execute(input, ctx, opts) {
    const viewport =
      input.width || input.height
        ? { width: input.width ?? 1440, height: input.height ?? 900 }
        : undefined;
    await promptForPrivateOrigin(ctx, input.url, signalFor(ctx, opts));
    return json(
      await managerFor(ctx).open(
        owner(ctx),
        { url: input.url, viewport, trace: input.trace, conversationId: ctx.session?.id },
        signalFor(ctx, opts),
      ),
    );
  },
};

export const browserListTool = {
  name: 'browser_list',
  description:
    'List browser sessions owned by the current agent without exposing other agents sessions.',
  permission: 'auto',
  mutating: false,
  riskTier: 'safe',
  capabilities: [ToolCapabilities.NET_OUTBOUND],
  inputSchema: { type: 'object', properties: {} },
  async execute(_input: Record<string, never>, ctx: Context, _opts?: { signal: AbortSignal }) {
    return json(await managerFor(ctx).list(owner(ctx)));
  },
} satisfies Tool<Record<string, never>>;

export const browserStatusTool: Tool<Record<string, never>> = {
  name: 'browser_status',
  description: 'Check whether first-party Playwright Chromium is installed and ready to launch.',
  permission: 'auto',
  mutating: false,
  riskTier: 'safe',
  capabilities: [ToolCapabilities.TOOL_META],
  inputSchema: { type: 'object', properties: {} },
  async execute() {
    return json(await browserInstallationDiagnostics());
  },
};

export const browserNavigateTool: Tool<BrowserNavigateInput> = {
  name: 'browser_navigate',
  description:
    'Navigate an owned browser session to an approved http(s) URL. ' +
    'Allow a private/localhost origin for this project with /browser allow <origin>, or WRONGSTACK_BROWSER_PRIVATE_ORIGINS.',
  usageHint: 'browser_navigate({ sessionId, url })',
  permission: 'confirm',
  mutating: true,
  riskTier: 'standard',
  capabilities: [ToolCapabilities.NET_OUTBOUND],
  subjectKey: 'url',
  inputSchema: {
    type: 'object',
    properties: { sessionId: sessionIdSchema, url: { type: 'string', minLength: 1 } },
    required: ['sessionId', 'url'],
  },
  async execute(input, ctx, opts) {
    const signal = signalFor(ctx, opts);
    return json(
      await managerFor(ctx).navigate(input.sessionId, owner(ctx), input.url, signal, () =>
        promptForPrivateOrigin(ctx, input.url, signal),
      ),
    );
  },
};

export const browserSnapshotTool: Tool<BrowserSnapshotInput> = {
  name: 'browser_snapshot',
  description: 'Return bounded accessibility state plus redacted console and network summaries.',
  usageHint: 'browser_snapshot({ sessionId })',
  permission: 'auto',
  mutating: false,
  riskTier: 'safe',
  capabilities: [ToolCapabilities.NET_OUTBOUND],
  inputSchema: {
    type: 'object',
    properties: { sessionId: sessionIdSchema },
    required: ['sessionId'],
  },
  async execute(input, ctx, opts) {
    return json(await managerFor(ctx).snapshot(input.sessionId, owner(ctx), signalFor(ctx, opts)));
  },
};

export const browserScreenshotTool: Tool<BrowserScreenshotInput> = {
  name: 'browser_screenshot',
  description:
    'Capture a page or element PNG and return sensitive artifact metadata with integrity hash.',
  usageHint: 'browser_screenshot({ sessionId, fullPage?, selector? })',
  permission: 'confirm',
  // WS-046: the element/expression acted on, not the sessionId — a trust
  // rule must distinguish clicking one control from another.
  subjectKey: 'selector',
  mutating: true,
  riskTier: 'safe',
  capabilities: [ToolCapabilities.NET_OUTBOUND],
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: sessionIdSchema,
      fullPage: { type: 'boolean' },
      selector: { type: 'string', minLength: 1 },
    },
    required: ['sessionId'],
  },
  async execute(input, ctx, opts) {
    return json(
      await managerFor(ctx).screenshot(
        input.sessionId,
        owner(ctx),
        { fullPage: input.fullPage, selector: input.selector },
        signalFor(ctx, opts),
      ),
    );
  },
};

function selectorTool(
  name: string,
  description: string,
  run: (
    manager: BrowserSessionManager,
    input: BrowserSelectorInput,
    ownerId: string,
    signal: AbortSignal,
  ) => Promise<void>,
): Tool<BrowserSelectorInput> {
  return {
    name,
    description,
    usageHint: `${name}({ sessionId, selector })`,
    permission: 'confirm',
    // WS-046: the element/expression acted on, not the sessionId — a trust
    // rule must distinguish clicking one control from another.
    subjectKey: 'selector',
    mutating: true,
    riskTier: 'standard',
    capabilities: [ToolCapabilities.NET_OUTBOUND],
    inputSchema: {
      type: 'object',
      properties: { sessionId: sessionIdSchema, selector: { type: 'string', minLength: 1 } },
      required: ['sessionId', 'selector'],
    },
    async execute(input, ctx, opts) {
      await run(managerFor(ctx), input, owner(ctx), signalFor(ctx, opts));
      return 'ok';
    },
  };
}

export const browserClickTool = selectorTool(
  'browser_click',
  'Click an element in an owned browser session.',
  (manager, input, ownerId, signal) =>
    manager.click(input.sessionId, ownerId, input.selector, signal),
);

export const browserHoverTool = selectorTool(
  'browser_hover',
  'Hover an element in an owned browser session.',
  (manager, input, ownerId, signal) =>
    manager.hover(input.sessionId, ownerId, input.selector, signal),
);

export const browserTypeTool: Tool<BrowserTypeInput> = {
  name: 'browser_type',
  description:
    'Fill an input in an owned browser session. Use secretEnv instead of text for credentials so values stay out of tool arguments and session audit.',
  usageHint: 'browser_type({ sessionId, selector, text? | secretEnv? })',
  permission: 'confirm',
  // WS-046: the element/expression acted on, not the sessionId — a trust
  // rule must distinguish clicking one control from another.
  subjectKey: 'selector',
  mutating: true,
  riskTier: 'standard',
  capabilities: [ToolCapabilities.NET_OUTBOUND],
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: sessionIdSchema,
      selector: { type: 'string', minLength: 1 },
      text: { type: 'string' },
      secretEnv: {
        type: 'string',
        pattern: '^[A-Z_][A-Z0-9_]*$',
        description: 'Host environment variable resolved only at execution time.',
      },
    },
    required: ['sessionId', 'selector'],
  },
  validate(input) {
    return (input.text === undefined) === (input.secretEnv === undefined)
      ? ['exactly one of text or secretEnv is required']
      : [];
  },
  async execute(input, ctx, opts) {
    const value = input.text ?? (input.secretEnv ? process.env[input.secretEnv] : undefined);
    if (value === undefined) {
      throw new Error(`browser: secret environment variable "${input.secretEnv ?? ''}" is not set`);
    }
    await managerFor(ctx).type(
      input.sessionId,
      owner(ctx),
      input.selector,
      value,
      signalFor(ctx, opts),
    );
    return 'ok';
  },
};

export const browserSelectTool: Tool<BrowserSelectInput> = {
  name: 'browser_select',
  description: 'Select an option in an owned browser session.',
  usageHint: 'browser_select({ sessionId, selector, value })',
  permission: 'confirm',
  // WS-046: the element/expression acted on, not the sessionId — a trust
  // rule must distinguish clicking one control from another.
  subjectKey: 'selector',
  mutating: true,
  riskTier: 'standard',
  capabilities: [ToolCapabilities.NET_OUTBOUND],
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: sessionIdSchema,
      selector: { type: 'string', minLength: 1 },
      value: { type: 'string' },
    },
    required: ['sessionId', 'selector', 'value'],
  },
  async execute(input, ctx, opts) {
    await managerFor(ctx).select(
      input.sessionId,
      owner(ctx),
      input.selector,
      input.value,
      signalFor(ctx, opts),
    );
    return 'ok';
  },
};

export const browserPressTool: Tool<BrowserPressInput> = {
  name: 'browser_press',
  description: 'Press a keyboard key in an owned browser session.',
  usageHint: 'browser_press({ sessionId, key })',
  permission: 'confirm',
  // WS-046: the element/expression acted on, not the sessionId — a trust
  // rule must distinguish clicking one control from another.
  subjectKey: 'key',
  mutating: true,
  riskTier: 'standard',
  capabilities: [ToolCapabilities.NET_OUTBOUND],
  inputSchema: {
    type: 'object',
    properties: { sessionId: sessionIdSchema, key: { type: 'string', minLength: 1 } },
    required: ['sessionId', 'key'],
  },
  async execute(input, ctx, opts) {
    await managerFor(ctx).press(input.sessionId, owner(ctx), input.key, signalFor(ctx, opts));
    return 'ok';
  },
};

export const browserDragTool: Tool<BrowserDragInput> = {
  name: 'browser_drag',
  description: 'Drag one element to another in an owned browser session.',
  usageHint: 'browser_drag({ sessionId, from, to })',
  permission: 'confirm',
  // WS-046: the element/expression acted on, not the sessionId — a trust
  // rule must distinguish clicking one control from another.
  subjectKey: 'from',
  mutating: true,
  riskTier: 'standard',
  capabilities: [ToolCapabilities.NET_OUTBOUND],
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: sessionIdSchema,
      from: { type: 'string', minLength: 1 },
      to: { type: 'string', minLength: 1 },
    },
    required: ['sessionId', 'from', 'to'],
  },
  async execute(input, ctx, opts) {
    await managerFor(ctx).drag(
      input.sessionId,
      owner(ctx),
      input.from,
      input.to,
      signalFor(ctx, opts),
    );
    return 'ok';
  },
};

export const browserWaitTool: Tool<BrowserWaitInput> = {
  name: 'browser_wait',
  description: 'Wait for an element or a bounded duration in an owned browser session.',
  usageHint: 'browser_wait({ sessionId, selector?, timeoutMs? })',
  permission: 'auto',
  mutating: false,
  riskTier: 'safe',
  capabilities: [ToolCapabilities.NET_OUTBOUND],
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: sessionIdSchema,
      selector: { type: 'string', minLength: 1 },
      timeoutMs: { type: 'integer', minimum: 0, maximum: 30000 },
    },
    required: ['sessionId'],
  },
  async execute(input, ctx, opts) {
    await managerFor(ctx).wait(
      input.sessionId,
      owner(ctx),
      { selector: input.selector, timeoutMs: input.timeoutMs },
      signalFor(ctx, opts),
    );
    return 'ok';
  },
};

export const browserEvaluateTool: Tool<BrowserEvaluateInput> = {
  name: 'browser_evaluate',
  description:
    'Evaluate bounded JavaScript in the page. Requires confirmation because page code is arbitrary.',
  usageHint: 'browser_evaluate({ sessionId, expression })',
  permission: 'confirm',
  // WS-046: the element/expression acted on, not the sessionId — a trust
  // rule must distinguish clicking one control from another.
  subjectKey: 'expression',
  mutating: true,
  riskTier: 'destructive',
  capabilities: [ToolCapabilities.NET_OUTBOUND, ToolCapabilities.TOOL_MUTATE_ANY],
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: sessionIdSchema,
      expression: { type: 'string', minLength: 1, maxLength: 16384 },
    },
    required: ['sessionId', 'expression'],
  },
  async execute(input, ctx, opts) {
    return json(
      await managerFor(ctx).evaluate(
        input.sessionId,
        owner(ctx),
        input.expression,
        signalFor(ctx, opts),
      ),
    );
  },
};

export const browserUploadTool: Tool<BrowserUploadInput> = {
  name: 'browser_upload',
  description: 'Upload project-local files through a file input in an owned browser session.',
  usageHint: 'browser_upload({ sessionId, selector, files })',
  permission: 'confirm',
  // WS-046: the element/expression acted on, not the sessionId — a trust
  // rule must distinguish clicking one control from another.
  subjectKey: 'selector',
  mutating: true,
  riskTier: 'destructive',
  capabilities: [ToolCapabilities.NET_OUTBOUND, ToolCapabilities.FS_READ],
  inputSchema: {
    type: 'object',
    properties: {
      sessionId: sessionIdSchema,
      selector: { type: 'string', minLength: 1 },
      files: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1 } },
    },
    required: ['sessionId', 'selector', 'files'],
  },
  async execute(input, ctx, opts) {
    const root = ctx.projectRoot ?? ctx.cwd ?? process.cwd();
    await managerFor(ctx).upload(
      input.sessionId,
      owner(ctx),
      input.selector,
      input.files,
      root,
      signalFor(ctx, opts),
    );
    return 'ok';
  },
};

export const browserCloseTool: Tool<BrowserCloseInput> = {
  name: 'browser_close',
  description:
    'Close an owned browser session, reclaim its context, and return sensitive trace metadata.',
  usageHint: 'browser_close({ sessionId })',
  permission: 'auto',
  mutating: false,
  riskTier: 'safe',
  capabilities: [ToolCapabilities.NET_OUTBOUND],
  inputSchema: {
    type: 'object',
    properties: { sessionId: sessionIdSchema },
    required: ['sessionId'],
  },
  async execute(input, ctx) {
    return json(await managerFor(ctx).close(input.sessionId, owner(ctx)));
  },
};

export const browserTools: Tool[] = [
  browserOpenTool,
  browserStatusTool,
  browserListTool,
  browserNavigateTool,
  browserSnapshotTool,
  browserScreenshotTool,
  browserClickTool,
  browserTypeTool,
  browserSelectTool,
  browserPressTool,
  browserHoverTool,
  browserDragTool,
  browserWaitTool,
  browserEvaluateTool,
  browserUploadTool,
  browserCloseTool,
];

const BROWSER_PARAMETER_DESCRIPTIONS: Readonly<Record<string, string>> = {
  sessionId: 'Owned browser session id returned by browser_open.',
  url: 'Absolute HTTP(S) URL. Private and localhost origins require an allowlist.',
  width: 'Viewport width in CSS pixels; defaults to the browser profile width.',
  height: 'Viewport height in CSS pixels; defaults to the browser profile height.',
  selector: 'Stable CSS or supported Playwright selector for the target element.',
  fullPage: 'Capture the entire scrollable page instead of only the viewport.',
  text: 'Literal text to enter. Do not use for credentials; use secretEnv instead.',
  value: 'Option value to select from the target select control.',
  key: 'Keyboard key or shortcut to send, such as Enter or Control+A.',
  from: 'Selector for the element to drag.',
  to: 'Selector for the destination element.',
  timeoutMs: 'Maximum wait time in milliseconds, capped at 30 seconds.',
  expression: 'JavaScript expression evaluated in the page; treat page code as arbitrary.',
  files: 'Project-local file paths to upload through the selected file input.',
};

function annotateBrowserParameterDescriptions(): void {
  for (const tool of browserTools) {
    for (const [name, property] of Object.entries(tool.inputSchema.properties ?? {})) {
      property.description ??=
        BROWSER_PARAMETER_DESCRIPTIONS[name] ?? `Input value for browser action field "${name}".`;
    }
  }
}

annotateBrowserParameterDescriptions();

// Keep suite-level metadata uniform. Without a runtime category the sixteen
// browser tools were invisible to category-based `tool_search` discovery even
// though their website projections grouped them as Browser & E2E.
for (const tool of browserTools) tool.category = 'Browser & E2E';
for (const tool of browserTools) tool.icon = 'web';
for (const tool of browserTools) tool.timeoutMs ??= 60_000;

export const BROWSER_TOOL_NAMES: readonly string[] = Object.freeze(browserTools.map((t) => t.name));

/** Bulk enable all browser automation tools in a ToolRegistry. */
export function enableBrowserSuite(registry: { enable(name: string): boolean }): number {
  let count = 0;
  for (const name of BROWSER_TOOL_NAMES) {
    if (registry.enable(name)) count++;
  }
  return count;
}

/** Bulk disable all browser automation tools in a ToolRegistry so they do not enter context. */
export function disableBrowserSuite(registry: {
  disable(name: string, reason?: 'user' | 'auto-thinned'): boolean;
}): number {
  let count = 0;
  for (const name of BROWSER_TOOL_NAMES) {
    if (registry.disable(name, 'user')) count++;
  }
  return count;
}

/** Check whether all browser tools are currently enabled in the registry. */
export function isBrowserSuiteEnabled(registry: {
  isDisabled(name: string): boolean;
  get(name: string): unknown;
}): boolean {
  return BROWSER_TOOL_NAMES.every(
    (name) => !registry.isDisabled(name) && registry.get(name) !== undefined,
  );
}

export async function shutdownBrowserTools(): Promise<void> {
  const active = [...managers.values()];
  managers.clear();
  await Promise.all(active.map((manager) => manager.dispose()));
}
