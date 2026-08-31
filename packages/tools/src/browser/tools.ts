import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { ToolCapabilities } from '@wrongstack/core/security';
import type { Tool } from '@wrongstack/core/types';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { BrowserSessionManager, browserInstallationDiagnostics } from './manager.js';
import { parsePrivateOriginAllowlist } from './security.js';

const managers = new Map<string, BrowserSessionManager>();
const cleanupSignalByContext = new WeakMap<object, AbortSignal>();

function signalFor(ctx: Context, opts?: { signal?: AbortSignal }): AbortSignal {
  return opts?.signal ?? ctx.signal ?? new AbortController().signal;
}

function managerFor(ctx: Context): BrowserSessionManager {
  const root = path.resolve(ctx.projectRoot ?? ctx.cwd ?? process.cwd());
  let manager = managers.get(root);
  if (!manager) {
    const wpaths = resolveWstackPaths({ projectRoot: root });
    manager = new BrowserSessionManager({
      artifactRoot: path.join(wpaths.projectDir, 'browser-artifacts'),
      allowedPrivateOrigins: parsePrivateOriginAllowlist(
        process.env['WRONGSTACK_BROWSER_PRIVATE_ORIGINS'],
      ),
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

function owner(ctx: Context): string {
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

export const browserOpenTool: Tool<{
  url?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  trace?: boolean | undefined;
}> = {
  name: 'browser_open',
  description:
    'Open an isolated first-party Playwright browser session, optionally navigating to a URL. ' +
    'Private/localhost origins are blocked by default; enable specific origins via the WRONGSTACK_BROWSER_PRIVATE_ORIGINS env allowlist.',
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
    return json(
      await managerFor(ctx).open(
        owner(ctx),
        { url: input.url, viewport, trace: input.trace },
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

export const browserNavigateTool: Tool<{ sessionId: string; url: string }> = {
  name: 'browser_navigate',
  description:
    'Navigate an owned browser session to an approved http(s) URL. ' +
    'Private/localhost origins are blocked by default; enable specific origins via the WRONGSTACK_BROWSER_PRIVATE_ORIGINS env allowlist.',
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
    return json(
      await managerFor(ctx).navigate(input.sessionId, owner(ctx), input.url, signalFor(ctx, opts)),
    );
  },
};

export const browserSnapshotTool: Tool<{ sessionId: string }> = {
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

export const browserScreenshotTool: Tool<{
  sessionId: string;
  fullPage?: boolean | undefined;
  selector?: string | undefined;
}> = {
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

type SelectorInput = { sessionId: string; selector: string };

function selectorTool(
  name: string,
  description: string,
  run: (
    manager: BrowserSessionManager,
    input: SelectorInput,
    ownerId: string,
    signal: AbortSignal,
  ) => Promise<void>,
): Tool<SelectorInput> {
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

export const browserTypeTool: Tool<
  SelectorInput & { text?: string | undefined; secretEnv?: string | undefined }
> = {
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

export const browserSelectTool: Tool<SelectorInput & { value: string }> = {
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

export const browserPressTool: Tool<{ sessionId: string; key: string }> = {
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

export const browserDragTool: Tool<{ sessionId: string; from: string; to: string }> = {
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

export const browserWaitTool: Tool<{
  sessionId: string;
  selector?: string | undefined;
  timeoutMs?: number | undefined;
}> = {
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

export const browserEvaluateTool: Tool<{ sessionId: string; expression: string }> = {
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

export const browserUploadTool: Tool<SelectorInput & { files: string[] }> = {
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

export const browserCloseTool: Tool<{ sessionId: string }> = {
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

for (const tool of browserTools) tool.icon = 'web';
for (const tool of browserTools) tool.timeoutMs ??= 60_000;

export async function shutdownBrowserTools(): Promise<void> {
  const active = [...managers.values()];
  managers.clear();
  await Promise.all(active.map((manager) => manager.dispose()));
}
