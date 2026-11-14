import { strict as assert } from 'node:assert';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect } from '@playwright/test';
import { WebSocketServer } from 'ws';
import { createHttpServer } from '../../webui-server/src/server/http-server.ts';

// Serve the real exported Next application through the production HTTP/CSP path.
// The loopback fixture implements the real protocol without making paid model calls.
const distDir = fileURLToPath(new URL('../dist', import.meta.url));
const uiVersion = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
).version;
const output = fileURLToPath(new URL('../../../.temp_files/vibeui/', import.meta.url));
await mkdir(output, { recursive: true });
const server = createHttpServer({ host: '127.0.0.1', distDir, apiToken: 'vibeui-smoke-token' });
const wss = new WebSocketServer({ server });
const received = [];
/** Frames the fixture sent to the page (for deterministic ordering waits). */
const fixtureSent = [];
const clients = new Set();
const memoryRecords = [
  {
    id: 'm1',
    text: 'Use Bun for package scripts.',
    kind: 'convention',
    scope: 'project',
    status: 'active',
    tags: ['tooling'],
    confidence: 0.9,
    createdAt: '2026-10-01T12:00:00Z',
    updatedAt: '2026-10-17T12:00:00Z',
    anchors: [{ type: 'file', path: 'package.json' }],
  },
  {
    id: 'm2',
    text: 'Keep interfaces focused.',
    kind: 'preference',
    scope: 'project',
    status: 'active',
    tags: ['design'],
  },
];
let connections = 0;
// One-shot server faults: refuse the next session.resume, ignore the next context.clear.
let failNextResume = false;
let silenceNextClear = false;
let selectedModel = 'fixture-model';
let effort = 'auto';
let sessionName = 'A place to start';
let workingMode = 'default';
let preferences = {
  yolo: false,
  yoloPlus: false,
  autonomy: 'suggest',
  autonomyDelayMs: 1000,
  nextStepsMode: 'optional',
  contextAutoCompact: true,
  contextStrategy: 'hybrid',
  contextMode: 'balanced',
  tokenSavingTier: 'auto',
  maxIterations: 20,
  autoProceedMaxIterations: 10,
  subagentsAllowed: true,
  subagentCompanionsAllowed: true,
  showModelReasoning: true,
  refinerProvider: '',
  refinerModel: '',
};
const designPrompt = JSON.parse(
  await readFile(
    new URL(
      '../../core/data/prompts/prompts/design/fluidflow-design-d2-glassmorphism-style.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
let promptLibrary = [
  designPrompt,
  {
    slug: 'review-target',
    title: 'Review a target',
    description: 'Reusable code review',
    category: 'quality',
    favorite: false,
    content: 'Review {{target}}',
    variables: [{ name: 'target', required: true }],
  },
];
let fixtureTools = [
  {
    name: 'read_file',
    owner: 'core',
    description: 'Read a project file',
    permission: 'read',
    mutating: false,
    disabled: false,
    params: ['path'],
  },
  {
    name: 'write_file',
    owner: 'core',
    description: 'Write project files',
    permission: 'write',
    mutating: true,
    disabled: true,
    params: ['path', 'content'],
  },
];
let mcpEnabled = true;
let rejectMcpDisable = true;
let instructionRevision = 1;
let instructionText = 'Original shared instructions';
let rejectInstructionSave = true;
let compacted = false;
let providerAccounts = [
  {
    id: 'fixture',
    type: 'fixture',
    family: 'openai',
    baseUrl: 'http://127.0.0.1:9999/v1',
    models: ['fixture-model'],
    apiKeys: [
      { label: 'main', maskedKey: 'fx...last', isActive: true },
      { label: 'provider', maskedKey: 'fx...next', isActive: false },
    ],
  },
];
const frame = (socket, type, payload) => {
  fixtureSent.push({ type, payload });
  if (socket.readyState === 1) socket.send(JSON.stringify({ type, payload }));
};
const session = (socket, sessionId = 'session-one', replayMessages, cwd = 'D:/workspace/studio') =>
  frame(socket, 'session.start', {
    sessionId,
    provider: 'fixture',
    model: selectedModel,
    mode: workingMode,
    appVersion: '1.1.7',
    reasoningEffortLevels: ['low', 'high'],
    effortSupported: true,
    projectReasoningEffort: 'high',
    projectName: 'VibeUI Studio',
    cwd,
    maxContext: selectedModel === 'small-model' ? 4096 : 128000,
    ...(replayMessages ? { replayMessages } : {}),
  });
wss.on('connection', (socket) => {
  let responseTimer;
  connections++;
  clients.add(socket);
  socket.on('close', () => clients.delete(socket));
  session(socket);
  socket.on('message', (raw) => {
    const message = JSON.parse(String(raw));
    received.push(message);
    const p = message.payload ?? {};
    if (message.type === 'ping') frame(socket, 'pong', {});
    if (message.type === 'provider.quota.get' || message.type === 'provider.quota.refresh')
      frame(socket, 'provider.quota', {
        snapshots: [
          {
            providerId: 'fixture',
            meterId: 'default',
            planLabel: 'Fixture plan',
            capturedAt: Date.now(),
            windows: [
              {
                id: '5h',
                label: '5 hours',
                usedPercent: 25,
                resetsAt: Math.floor(Date.now() / 1000) + 3600,
              },
            ],
          },
        ],
        ...(message.type === 'provider.quota.refresh'
          ? { refreshed: [{ providerId: 'fixture', status: 'ok' }] }
          : {}),
      });
    if (message.type === 'context.clear' && silenceNextClear) {
      silenceNextClear = false;
      return;
    }
    if (message.type === 'context.clear') {
      setTimeout(
        () =>
          frame(socket, 'session.start', {
            sessionId: p.sessionId,
            provider: 'fixture',
            model: selectedModel,
            projectName: 'VibeUI Studio',
            cwd: 'D:/workspace/studio',
            maxContext: 4096,
            reset: true,
            replayMessages: [],
          }),
        300,
      );
    }
    if (message.type === 'mailbox.send')
      frame(socket, 'mailbox.sent', {
        requestId: p.requestId,
        success: p.body !== 'reject-btw',
        ...(p.body === 'reject-btw'
          ? { error: 'BTW rejected by fixture' }
          : { messageId: 'btw-fixture' }),
      });
    if (message.type === 'memory.sage.listPage') {
      const matching = memoryRecords.filter(
        (item) =>
          (!p.query || item.text.toLowerCase().includes(p.query.toLowerCase())) &&
          (!p.kind || p.kind === 'all' || item.kind === p.kind) &&
          (!p.statuses || p.statuses.includes(item.status)),
      );
      frame(socket, 'memory.sage.listPage', {
        requestId: p.requestId,
        memories: matching,
        total: matching.length,
        nextCursor: null,
        stats: { total: 2 },
      });
    }
    if (message.type === 'memory.sage.get')
      frame(socket, 'memory.sage.get', {
        requestId: p.requestId,
        memory: memoryRecords.find((item) => item.id === p.id),
      });
    if (message.type === 'memory.sage.graph')
      frame(socket, 'memory.sage.graph', {
        requestId: p.requestId,
        query: p.query,
        edges: [
          { id: 'e1', from: 'mem:m1', to: 'mem:m2', relation: 'related_to', weight: 0.8 },
          ...Array.from({ length: 20 }, (_, i) => ({
            id: `distant-${i}`,
            from: 'mem:m2',
            to: `mem:distant-${i}`,
            relation: 'related_to',
          })),
        ],
        memories: memoryRecords,
        ...(p.query === 'mem:m2' ? { edges: [] } : {}),
      });
    if (message.type === 'prompts.list')
      frame(socket, 'prompts.list', { enabled: true, prompts: promptLibrary });
    if (message.type === 'prompts.content') {
      const prompt = promptLibrary.find((item) => item.slug === p.slug);
      frame(socket, 'prompts.content', { ...prompt, slug: p.slug, found: Boolean(prompt) });
    }
    if (message.type === 'prompts.favorite') {
      promptLibrary = promptLibrary.map((item) =>
        item.slug === p.slug ? { ...item, favorite: p.favorite } : item,
      );
      frame(socket, 'prompts.favorite', { success: true, slug: p.slug, favorite: p.favorite });
    }
    if (message.type === 'prompts.create') {
      promptLibrary.push({
        slug: 'saved-from-vibeui',
        title: p.title,
        content: p.content,
        category: p.category,
        variables: [],
        favorite: false,
      });
      frame(socket, 'prompts.created', { success: true, slug: 'saved-from-vibeui' });
    }
    if (message.type === 'skills.content') {
      frame(socket, 'skills.content', { name: 'wrong-skill', body: 'Wrong skill content' });
      frame(socket, 'skills.content', {
        name: p.name,
        body: '# Testing instructions\nVerify behavior before claiming success.',
      });
    }
    if (message.type === 'tools.list')
      frame(socket, 'tools.list', { requestId: p.requestId, tools: fixtureTools });
    if (message.type === 'tool.enable' || message.type === 'tool.disable') {
      fixtureTools = fixtureTools.map((tool) =>
        tool.name === p.name ? { ...tool, disabled: message.type === 'tool.disable' } : tool,
      );
      frame(socket, message.type === 'tool.enable' ? 'tool.enabled' : 'tool.disabled', {
        name: p.name,
        ok: true,
      });
    }
    if (message.type === 'mcp.list')
      frame(socket, 'mcp.list', {
        servers: [
          {
            name: 'docs-service',
            status: mcpEnabled ? 'connected' : 'stopped',
            enabled: mcpEnabled,
            transport: 'http',
            tools: ['search_docs'],
            description: 'Project documentation tools',
          },
        ],
      });
    if (message.type === 'mcp.disable' || message.type === 'mcp.enable') {
      if (message.type === 'mcp.disable' && rejectMcpDisable) {
        rejectMcpDisable = false;
        frame(socket, 'mcp.operation_result', { success: false, message: 'Connection is in use.' });
      } else {
        mcpEnabled = message.type === 'mcp.enable';
        frame(socket, 'mcp.operation_result', { success: true, message: 'Connection updated.' });
      }
    }
    if (message.type === 'mcp.restart')
      frame(socket, 'mcp.operation_result', { success: true, message: 'Connection restarted.' });
    if (message.type === 'memory.list')
      frame(socket, 'memory.list', {
        requestId: p.requestId,
        text: '## Project memory\nUse Bun for package scripts.\nKeep interfaces focused.',
      });
    if (message.type === 'user_instructions.get')
      frame(socket, 'user_instructions', {
        text: instructionText,
        mtimeMs: instructionRevision,
        exists: true,
      });
    if (message.type === 'user_instructions.save') {
      if (rejectInstructionSave) {
        rejectInstructionSave = false;
        instructionText = 'Updated outside this editor';
        instructionRevision = 2;
        frame(socket, 'user_instructions', {
          error: 'Instructions changed on disk. Reload before saving.',
        });
      } else {
        assert.equal(p.baseMtimeMs, instructionRevision);
        instructionText = p.text;
        instructionRevision++;
        frame(socket, 'user_instructions', {
          text: instructionText,
          mtimeMs: instructionRevision,
          saved: true,
        });
      }
    }
    if (message.type === 'abort') {
      clearTimeout(responseTimer);
      setTimeout(
        () =>
          frame(socket, 'run.result', { sessionId: p.sessionId, status: 'aborted', iterations: 1 }),
        100,
      );
    }
    if (message.type === 'prefs.get')
      frame(socket, 'prefs.updated', {
        sessionId: p.sessionId,
        reasoningEffort: effort,
        ...preferences,
      });
    if (message.type === 'prefs.update') {
      if (p.reasoningEffort) effort = p.reasoningEffort;
      preferences = { ...preferences, ...p };
      delete preferences.sessionId;
      frame(socket, 'prefs.updated', {
        ...preferences,
        sessionId: p.sessionId,
        reasoningEffort: effort,
      });
    }
    if (message.type === 'autonomy.switch') {
      preferences.autonomy = p.mode;
      frame(socket, 'prefs.updated', { sessionId: p.sessionId, autonomy: p.mode });
    }
    if (message.type === 'modes.list')
      frame(socket, 'modes.list', {
        sessionId: p.sessionId,
        activeId: workingMode,
        modes: [
          { id: 'default', name: 'Default', description: 'General coding agent' },
          { id: 'plan', name: 'Plan', description: 'Plan before making changes' },
        ],
      });
    if (message.type === 'mode.switch') {
      workingMode = p.id;
      session(socket, p.sessionId);
    }
    if (message.type === 'skills.list') {
      frame(socket, 'skills.list', {
        requestId: 'stale-request',
        skills: [{ name: 'wrong-skill', description: 'Must be ignored' }],
      });
      frame(socket, 'skills.list', {
        requestId: p.requestId,
        enabled: true,
        skills: [
          { name: 'testing', description: 'Write and verify behavioral tests' },
          { name: 'design-system-foundry', description: 'Create a cohesive design system' },
          ...Array.from({ length: 40 }, (_, i) => ({
            name: `skill-${String(i).padStart(2, '0')}`,
            description: 'A detailed workspace capability',
          })),
        ],
      });
    }
    if (message.type === 'context.debug')
      frame(socket, 'context.debug', {
        sessionId: p.sessionId,
        mode: 'balanced',
        total: 2400,
        systemPrompt: 1000,
        tools: { count: 1, total: 400, breakdown: [{ name: 'read_file', tokens: 400 }] },
        messages: { total: 1000, count: 1, breakdown: [] },
        residency: { retained: 1200 },
        retention: { strategy: 'balanced' },
      });
    if (message.type === 'context.editor.open') {
      frame(socket, 'context.editor.snapshot', {
        sessionId: 'foreign-session',
        revision: 'wrong',
        messages: [{ role: 'user', content: 'Foreign secret should not appear' }],
      });
      frame(socket, 'context.editor.snapshot', {
        sessionId: p.sessionId,
        revision: 'snapshot-1',
        messages: [
          {
            role: 'user',
            content: compacted ? 'Compacted runtime context' : 'Runtime-only context entry',
          },
        ],
        readonlyContext: {
          systemPromptTokens: 1000,
          toolSchemaTokens: 400,
          toolCount: 1,
          totalTokens: 2400,
          messageTokens: 1000,
        },
        readonlyContent: {
          systemPrompt: [{ type: 'text', text: 'Actual session instructions from the runtime' }],
          tools: [
            {
              name: 'read_file',
              description: 'Read project files',
              inputSchema: { type: 'object' },
            },
          ],
        },
      });
    }
    if (message.type === 'stats.get')
      frame(socket, 'stats.get', {
        sessionId: p.sessionId,
        usage: { input: 12345, output: 678, total: 13023 },
        cache: { readTokens: 90000, writeTokens: 7000, hitRatio: 0.75, last: { hitRatio: 0.8 } },
        currentRequest: { cacheRead: 1200 },
      });
    if (message.type === 'context.compact') {
      frame(socket, 'context.compacted', { sessionId: 'foreign-session', before: 6000, after: 1 });
      setTimeout(() => {
        compacted = true;
        frame(socket, 'context.compacted', {
          sessionId: p.sessionId,
          before: 6000,
          after: 2500,
          saved: 3500,
        });
      }, 400);
    }
    if (message.type === 'model.switch') {
      selectedModel = p.model;
      session(socket, p.sessionId);
    }
    if (message.type === 'model.refine') {
      frame(socket, 'model.refine_result', {
        sessionId: p.sessionId,
        requestId: 'stale-refinement',
        refined: 'Stale result must be ignored',
      });
      frame(socket, 'model.refine_result', {
        sessionId: p.sessionId,
        requestId: p.requestId,
        ...(p.text === 'Fail refinement'
          ? { error: 'Fixture refiner unavailable' }
          : {
              refined: 'Explain the project clearly.',
              english: 'Explain the project in English.',
              refinedWith: { provider: 'fixture', model: 'refiner-model' },
            }),
      });
    }
    if (message.type === 'files.tree')
      frame(socket, 'files.tree', {
        sessionId: p.sessionId,
        root: 'D:/workspace/studio',
        tree: [
          {
            name: 'src',
            path: 'src',
            type: 'directory',
            children: [{ name: 'app.tsx', path: 'src/app.tsx', type: 'file' }],
          },
          { name: 'notes.md', path: 'notes.md', type: 'file' },
          {
            name: 'assets',
            path: 'assets',
            type: 'directory',
            children: [{ name: 'cover.png', path: 'assets/cover.png', type: 'file' }],
          },
        ],
      });
    if (message.type === 'session.rename') {
      sessionName = p.name;
      frame(socket, 'key.operation_result', { success: true, message: 'Session renamed.' });
      frame(socket, 'sessions.list', {
        sessions: [
          { id: 'session-one', title: sessionName, startedAt: '2026-10-17T10:00:00Z' },
          { id: 'session-two', title: 'Second session', startedAt: '2026-10-17T09:00:00Z' },
        ],
      });
    }
    if (message.type === 'user.input_submit')
      frame(socket, 'user.input_resolved', {
        sessionId: p.sessionId,
        requestId: p.response.requestId,
      });
    if (message.type === 'files.read')
      frame(socket, 'files.read', {
        ...p,
        content: p.filePath.endsWith('REPORT.md')
          ? '# Generated report\nVerified local artifact.\n[Open HTML preview](./preview.html)'
          : p.filePath.endsWith('preview.html')
            ? '<!doctype html><html><body><h1>Generated HTML preview</h1><p>Static report content.</p></body></html>'
            : 'A concise project report.',
      });
    if (message.type === 'session.subscribe')
      frame(socket, 'session.run_state', { sessionId: p.sessionIds[0], isRunning: false });
    if (message.type === 'files.image')
      frame(socket, 'files.image', {
        ...p,
        dataUrl:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      });
    if (message.type === 'providers.list')
      frame(socket, 'provider.catalog', {
        providers: [
          {
            id: 'fixture',
            name: 'Local fixture',
            hasApiKey: true,
            family: 'openai',
            apiBase: 'http://127.0.0.1:9999/v1',
          },
        ],
      });
    if (message.type === 'providers.saved')
      frame(socket, 'providers.saved', { providers: providerAccounts });
    if (message.type === 'auth.oauth.list')
      frame(socket, 'auth.oauth.providers', {
        providers: [
          {
            id: 'fixture-chatgpt',
            providerId: 'openai-codex',
            label: 'OpenAI / ChatGPT',
            description: 'Sign in with your existing subscription',
          },
        ],
      });
    if (message.type === 'auth.oauth.start')
      frame(socket, 'auth.oauth.status', {
        kind: p.kind,
        providerId: p.providerId,
        phase: 'awaiting_browser',
        authorizeUrl: 'https://example.com/oauth',
        bound: false,
      });
    if (message.type === 'auth.oauth.code')
      frame(socket, 'auth.oauth.status', {
        kind: p.kind,
        phase: 'success',
        message: 'Fixture account signed in.',
      });
    if (message.type === 'provider.add') {
      if (p.id !== 'bad-provider')
        providerAccounts.push({
          id: p.id,
          type: p.type || p.family,
          family: p.family,
          baseUrl: p.baseUrl,
          models: p.models || [],
          apiKeys: p.apiKey ? [{ label: 'default', maskedKey: 'fx...new', isActive: true }] : [],
        });
      frame(socket, 'key.operation_result', {
        requestId: p.requestId,
        success: p.id !== 'bad-provider',
        message:
          p.id === 'bad-provider' ? 'Fixture credential validation failed.' : 'Provider saved.',
      });
    }
    if (message.type === 'key.delete') {
      providerAccounts = providerAccounts.map((provider) =>
        provider.id === p.providerId
          ? { ...provider, apiKeys: provider.apiKeys.filter((key) => key.label !== p.label) }
          : provider,
      );
      frame(socket, 'key.operation_result', {
        requestId: p.requestId,
        success: true,
        message: 'Key removed.',
      });
    }
    if (message.type === 'provider.models' && p.providerId === 'fixture')
      frame(socket, 'provider.models', {
        provider: 'fixture',
        models: [
          { id: 'fixture-model', name: 'Fixture model', contextWindow: 128000 },
          { id: 'small-model', name: 'Small model', contextWindow: 4096 },
        ],
      });
    if (message.type === 'sessions.list')
      frame(socket, 'sessions.list', {
        sessions: [
          { id: 'session-one', title: sessionName, startedAt: '2026-10-17T10:00:00Z' },
          { id: 'session-two', title: 'Second session', startedAt: '2026-10-17T09:00:00Z' },
        ],
      });
    if (message.type === 'git.changes')
      frame(socket, 'git.changes', {
        files: [{ path: 'src/app.tsx', status: 'M', added: 12, deleted: 3 }],
        dirs: {},
        repoPrefix: '',
      });
    if (message.type === 'git.diff')
      frame(socket, 'git.diff', {
        path: p.path,
        oldText: 'export const greeting = "hello";',
        newText: 'export const greeting = "hello, world";',
      });
    if (message.type === 'todos.get')
      frame(socket, 'todos.updated', {
        sessionId: p.sessionId,
        todos: [{ id: 'todo', content: 'Build a focused workspace', status: 'in_progress' }],
      });
    if (message.type === 'plan.get')
      frame(socket, 'plan.updated', {
        sessionId: p.sessionId,
        plan: { items: [{ id: 'plan', title: 'Connect the conversation', status: 'done' }] },
      });
    if (message.type === 'files.list')
      frame(socket, 'files.list', { files: ['src/app.tsx', 'src/styles.css'] });
    if (message.type === 'session.resume' && failNextResume) {
      failNextResume = false;
      frame(socket, 'error', {
        sessionId: p.sessionId,
        message: 'Fixture could not resume that session',
      });
      return;
    }
    if (message.type === 'session.resume')
      session(socket, p.id, [
        {
          role: 'user',
          origin: 'user_input',
          authoredLength: 1,
          content: [
            { type: 'text', text: 'Earlier question' },
            { type: 'text', text: '[TOOL COACH — advisory guidance] Runtime coaching' },
            { type: 'text', text: '[Same-session notes — in-process] Reviewer observation' },
          ],
        },
        { role: 'assistant', content: 'Restored answer' },
      ]);
    if (message.type === 'session.new') session(socket, `new-session-${connections}`, []);
    if (message.type === 'user_message') {
      if (p.content === 'Fail safely') {
        frame(socket, 'tool.started', {
          sessionId: p.sessionId,
          id: 'interrupted-tool',
          name: 'write_file',
          input: {},
        });
        setTimeout(
          () =>
            frame(socket, 'error', {
              sessionId: p.sessionId,
              message: 'Fixture provider failed',
              phase: 'provider',
            }),
          700,
        );
        return;
      }
      frame(socket, 'provider.text_delta', {
        sessionId: p.sessionId,
        messageId: `reply-${p.id}`,
        text: 'Building a calmer ',
      });
      frame(socket, 'tool.started', {
        sessionId: p.sessionId,
        id: `tool-${p.id}`,
        name: 'read_file',
        input: { path: 'src/app.tsx' },
      });
      if (p.content === 'Hold for queue layout') return;
      responseTimer = setTimeout(
        () => {
          frame(socket, 'provider.text_delta', {
            sessionId: p.sessionId,
            messageId: `reply-${p.id}`,
            text: 'workspace.',
          });
          frame(socket, 'tool.executed', {
            sessionId: p.sessionId,
            id: `tool-${p.id}`,
            name: 'read_file',
            ok: true,
            output: 'File inspected.',
            durationMs: 12,
          });
          frame(socket, 'provider.response', {
            sessionId: p.sessionId,
            content: [
              {
                type: 'text',
                text:
                  p.content === 'Auto ownership seed'
                    ? 'Continue.\n<nextsteps>\n1. Auto follow-up proof auto="true"\n</nextsteps>'
                    : p.content === 'Auto cancellation seed'
                      ? 'Continue.\n<nextsteps>\n1. Cancelled follow-up proof auto="true"\n</nextsteps>'
                      : 'Building a calmer workspace.\n<nextsteps>\n1. Review keyboard navigation\n2. Check mobile layout\n</nextsteps>',
              },
            ],
            stopReason: 'end_turn',
          });
          frame(socket, 'run.result', {
            sessionId: p.sessionId,
            requestId: p.id,
            status: 'done',
            iterations: 1,
          });
        },
        p.content === 'Start before steering' ? 3000 : 700,
      );
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const errors = [];
const themeContrasts = [];
const useStudioFixture = (page) =>
  page.addInitScript(() => {
    if (window.top !== window) return;
    const key = 'wrongstack.vibeui.workspace-view.v1';
    if (!localStorage.getItem(key))
      localStorage.setItem(
        key,
        JSON.stringify({
          view: 'studio',
          ideas: true,
          shortcuts: true,
          guidance: true,
          hiddenIntros: [],
        }),
      );
  });
try {
  // The picker must fit short viewports and keep keyboard text composition local.
  {
    const pickerPage = await browser.newPage({ viewport: { width: 320, height: 360 } });
    pickerPage.on('pageerror', (error) => errors.push(error.message));
    await useStudioFixture(pickerPage);
    try {
      await pickerPage.goto(origin);
      await expect(pickerPage.locator('.connection-chip')).toHaveText('Ready');
      await expect(pickerPage.locator('.model-trigger')).toBeEnabled();
      await pickerPage.keyboard.press('Control+k');
      const search = pickerPage.getByRole('combobox', { name: 'Search models', exact: true });
      await expect(search).toBeVisible();
      await expect(
        pickerPage.getByRole('listbox', { name: 'Models', exact: true }).getByRole('option'),
      ).toHaveCount(2);
      const pickerBounds = await pickerPage.locator('.model-popover').boundingBox();
      assert.ok(
        pickerBounds.y >= 0 && pickerBounds.y + pickerBounds.height <= 360,
        'The model picker must fit inside a short viewport',
      );
      await expect(
        pickerPage.getByRole('button', { name: 'Provider settings', exact: true }),
      ).toBeInViewport();
      await search.fill('no-such-model');
      await pickerPage.keyboard.press('Escape');
      await pickerPage.keyboard.press('Control+k');
      await expect(search).toHaveValue('');
      const active = await search.getAttribute('aria-activedescendant');
      await search.dispatchEvent('keydown', { key: 'ArrowDown', isComposing: true });
      await expect(search).toHaveAttribute('aria-activedescendant', active);
      await search.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
      await expect(search).toBeVisible();
      await pickerPage.screenshot({
        path: join(output, 'model-picker-short.png'),
        animations: 'disabled',
      });
      await pickerPage.keyboard.press('Escape');
      const longModel = 'acp/very-long-agent-runtime-and-model-identifier'.repeat(4);
      for (const socket of clients)
        frame(socket, 'session.start', {
          sessionId: 'session-one',
          provider: 'acp',
          model: longModel,
          projectName: 'VibeUI Studio',
          cwd: 'D:/workspace/studio',
          maxContext: 128000,
        });
      await expect(pickerPage.locator('.model-trigger')).toContainText(longModel);
      await expect(pickerPage.locator('.model-name')).toHaveAttribute('title', longModel);
      const triggerBounds = await pickerPage.locator('.model-trigger').boundingBox();
      assert.ok(triggerBounds.height <= 40, 'Long ACP model names must stay on one line');
      await expect(pickerPage.locator('.model-trigger .acp-runtime-badge')).toHaveText('ACP agent');
      await pickerPage.screenshot({
        path: join(output, 'model-name-320.png'),
        animations: 'disabled',
      });
    } finally {
      await pickerPage.close();
    }
  }
  // Layout regressions use fresh pages so persisted views cannot mask first-visit failures.
  {
    const compact = await browser.newPage({ viewport: { width: 320, height: 568 } });
    compact.on('pageerror', (error) => errors.push(error.message));
    try {
      await compact.goto(origin);
      await expect(compact.locator('.vibe-shell')).toBeVisible();
      await expect(compact.locator('.connection-chip')).toHaveText('Ready');
      await expect
        .poll(() => compact.locator('main.conversation').evaluate((el) => el.scrollTop))
        .toBe(0);
      const toolbar = await compact.locator('.session-toolbar').boundingBox();
      const composer = await compact.locator('.composer').boundingBox();
      const toolbarInset = await compact
        .locator('.session-toolbar')
        .evaluate((el) => Number.parseFloat(getComputedStyle(el).paddingLeft));
      assert.ok(
        Math.abs(toolbar.x + toolbarInset - composer.x) <= 1,
        'Mobile controls must align with the composer',
      );
      const shortcutRows = await compact
        .locator('.cozy-shortcuts > button')
        .evaluateAll(
          (buttons) =>
            new Set(
              buttons.map((button) =>
                Math.round(
                  button.getBoundingClientRect().top + button.getBoundingClientRect().height / 2,
                ),
              ),
            ).size,
        );
      assert.equal(shortcutRows, 1, 'Quick shortcuts must fit on one row at 320px');
      await compact.getByRole('button', { name: 'Open sessions', exact: true }).click();
      await compact.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(compact.getByRole('dialog')).toBeVisible();
      await compact.keyboard.press('Escape');
      await expect(compact.locator('.vibe-shell')).not.toHaveClass(/sidebar-open/);
    } finally {
      await compact.close();
    }
    const tablet = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await useStudioFixture(tablet);
    tablet.on('pageerror', (error) => errors.push(error.message));
    try {
      await tablet.goto(origin);
      await expect(tablet.locator('.connection-chip')).toHaveText('Ready');
      await expect(tablet.locator('.workspace-panel')).toHaveCount(0);
      const longProject = 'WorkspaceWithAnExtremelyLongUnbrokenProjectName'.repeat(4);
      for (const socket of clients)
        frame(socket, 'session.start', {
          sessionId: 'session-one',
          provider: 'fixture',
          model: selectedModel,
          projectName: longProject,
          cwd: 'D:/workspace/studio',
          maxContext: 128000,
        });
      await expect(tablet.locator('.project-card strong')).toHaveText(longProject);
      assert.ok(
        await tablet.locator('.project-card').evaluate((el) => el.scrollWidth <= el.clientWidth),
        'Long project names must stay inside the sidebar card',
      );
      const projectName = await tablet.locator('.header-project-name').boundingBox();
      const headerActions = await tablet.locator('.header-actions').boundingBox();
      assert.ok(
        projectName.x + projectName.width <= headerActions.x,
        'Header controls must remain reachable',
      );
      await tablet.getByRole('button', { name: 'Toggle workspace', exact: true }).click();
      await expect(tablet.locator('.workspace-panel')).toBeVisible();
      await tablet
        .getByRole('button', { name: 'Close workspace panel', exact: true })
        .click({ position: { x: 300, y: 150 } });
      await expect(tablet.locator('.workspace-panel')).toHaveCount(0);
    } finally {
      await tablet.close();
    }
  }
  const page = await browser.newPage({
    viewport: { width: 1512, height: 982 },
    deviceScaleFactor: 1,
  });
  page.setDefaultTimeout(10_000);
  await useStudioFixture(page);
  const auditTheme = async () => {
    const report = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const luminance = (token) => {
        ctx.fillStyle = style.getPropertyValue(`--${token}`).trim();
        ctx.fillRect(0, 0, 1, 1);
        const linear = [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => {
          const channel = value / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
        return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
      };
      const pairs = ['text', 'muted', 'faint', 'accent'].flatMap((foreground) =>
        ['base', 'sidebar', 'raised', 'hover', 'code-surface'].map((background) => [
          foreground,
          background,
        ]),
      );
      pairs.push(['accent-text', 'accent']);
      const contrasts = pairs.map(([foreground, background]) => {
        const a = luminance(foreground);
        const b = luminance(background);
        return { foreground, background, ratio: (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) };
      });
      return {
        theme: document.documentElement.dataset.theme,
        palette: document.documentElement.dataset.palette,
        baseLuminance: luminance('base'),
        contrasts,
      };
    });
    for (const pair of report.contrasts)
      assert.ok(
        pair.ratio >= 4.5,
        `${report.theme}/${report.palette}: ${pair.foreground} on ${pair.background} contrast ${pair.ratio.toFixed(2)} must meet 4.5:1`,
      );
    if (report.theme === 'dark')
      assert.ok(report.baseLuminance >= 0.02, 'Dark theme should use a lifted charcoal surface');
    themeContrasts.push({
      theme: report.theme,
      palette: report.palette,
      minimum: Math.min(...report.contrasts.map((pair) => pair.ratio)),
    });
  };
  // A screenshot of a conversation that follows its newest messages: wait until the
  // transcript has stopped growing (several unchanged polls in a row), then pin it to the
  // bottom through its own scroll handler. Without this the captured scroll offset depends
  // on how layout, focus restoration and streaming interleave, and differs run to run.
  const pinConversation = async () => {
    const conversation = page.locator('main.conversation');
    if ((await conversation.count()) === 0) return;
    await page.evaluate(() => {
      delete window.__pinHeight;
      window.__pinStable = 0;
    });
    await page.waitForFunction(
      () => {
        const height = document.querySelector('main.conversation')?.scrollHeight ?? 0;
        if (window.__pinHeight === height) window.__pinStable += 1;
        else {
          window.__pinHeight = height;
          window.__pinStable = 0;
        }
        return window.__pinStable >= 4;
      },
      undefined,
      { polling: 50 },
    );
    await conversation.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll'));
    });
    await expect(page.getByRole('button', { name: 'Latest', exact: true })).toHaveCount(0);
  };
  const captureNarrowDialog = async (name, { pin = false } = {}) => {
    const viewport = page.viewportSize();
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      if (pin) await pinConversation();
      const dialog = page.getByRole('dialog');
      const close = dialog.getByRole('button', { name: 'Close dialog', exact: true });
      const box = await close.boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= 844, `${name}: close fits on mobile`);
      assert.equal(
        await dialog.evaluate((element) => element.scrollWidth > element.clientWidth),
        false,
        `${name}: no modal overflow`,
      );
      await page.screenshot({
        path: join(output, `mobile-${name}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    } finally {
      await page.setViewportSize(viewport);
    }
  };
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  // File shortcuts survive reloads and belong only to their project.
  {
    const shelfPage = await browser.newPage({ viewport: { width: 1512, height: 982 } });
    shelfPage.setDefaultTimeout(10_000);
    shelfPage.on('pageerror', (error) => errors.push(error.message));
    shelfPage.on('console', (entry) => {
      if (entry.type() === 'error') errors.push(entry.text());
    });
    const openFiles = () =>
      shelfPage
        .locator('.header-actions')
        .getByRole('button', { name: 'Files', exact: true })
        .click();
    try {
      await shelfPage.goto(origin);
      await shelfPage.getByText('Ready', { exact: true }).waitFor();
      await openFiles();
      let files = shelfPage.getByRole('dialog');
      await files.getByRole('button', { name: 'notes.md', exact: true }).click();
      await files.getByRole('button', { name: 'Pin this file', exact: true }).click();
      await expect(
        files.getByRole('button', { name: 'Unpin this file', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
      await shelfPage.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await shelfPage.reload();
      await shelfPage.getByText('Ready', { exact: true }).waitFor();
      await openFiles();
      files = shelfPage.getByRole('dialog');
      await expect(
        files.getByRole('navigation', { name: 'Pinned files', exact: true }),
      ).toBeVisible();
      await files.getByRole('button', { name: 'Open pinned notes.md', exact: true }).click();
      await expect(files.getByText('A concise project report.', { exact: true })).toBeVisible();
      await files.getByRole('button', { name: 'Browse files', exact: true }).click();
      const shelfSocket = [...clients].at(-1);
      session(shelfSocket, 'other-files-project', [], 'D:/workspace/another');
      await expect
        .poll(() =>
          shelfPage.evaluate(
            () => JSON.parse(localStorage.getItem('wrongstack.vibeui.active-session.v1')).id,
          ),
        )
        .toBe('other-files-project');
      await expect(files.getByRole('button', { name: 'notes.md', exact: true })).toBeVisible();
      await expect(
        files.getByRole('navigation', { name: 'Pinned files', exact: true }),
      ).toHaveCount(0);
      await expect(
        files.getByRole('navigation', { name: 'Recent files', exact: true }),
      ).toHaveCount(0);
      session(shelfSocket, 'session-one', [], 'D:/workspace/studio');
      await expect
        .poll(() =>
          shelfPage.evaluate(
            () => JSON.parse(localStorage.getItem('wrongstack.vibeui.active-session.v1')).id,
          ),
        )
        .toBe('session-one');
      await expect(
        files.getByRole('navigation', { name: 'Pinned files', exact: true }),
      ).toBeVisible();
      await files.getByRole('button', { name: 'Unpin notes.md', exact: true }).click();
      await expect(
        files.getByRole('navigation', { name: 'Pinned files', exact: true }),
      ).toHaveCount(0);
      await expect(
        files.getByRole('button', { name: 'Open recent notes.md', exact: true }),
      ).toBeVisible();
      assert.equal(received.filter((message) => message.type === 'user_message').length, 0);
    } finally {
      await shelfPage.close();
    }
  }
  // Stacky uses the real animation path and remains outside the reading/composing areas.
  {
    const mascotPage = await browser.newPage({ viewport: { width: 1512, height: 982 } });
    mascotPage.setDefaultTimeout(10_000);
    mascotPage.on('pageerror', (error) => errors.push(error.message));
    mascotPage.on('console', (entry) => {
      if (entry.type() === 'error') errors.push(entry.text());
    });
    try {
      await mascotPage.goto(origin);
      await mascotPage.getByText('Ready', { exact: true }).waitFor();
      const actor = mascotPage.getByRole('button', { name: 'Meet Stacky', exact: true });
      const home = mascotPage.locator('.stacky-home');
      await expect(actor).toBeVisible();
      const helperDraft = mascotPage.getByRole('textbox', { name: 'Message', exact: true });
      await helperDraft.fill('Keep my next idea.');
      const helperMenu = mascotPage.getByRole('dialog', { name: 'Stacky companion', exact: true });
      await actor.click();
      await expect(
        helperMenu.getByRole('button', { name: 'Sit quietly', exact: true }),
      ).toHaveCount(0);
      const newChat = helperMenu.getByRole('button', { name: /^New chat/ });
      await expect(newChat).toBeVisible();
      await helperMenu.getByRole('tab', { name: 'Help', exact: true }).click();
      await mascotPage.screenshot({
        path: join(output, 'stacky-help.png'),
        animations: 'disabled',
      });
      for (const width of [320, 390]) {
        await mascotPage.setViewportSize({ width, height: 844 });
        assert.equal(
          await mascotPage.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
        );
        const menuBox = await helperMenu.boundingBox();
        assert.ok(
          menuBox.x >= 0 && menuBox.x + menuBox.width <= width,
          `Stacky menu fits at ${width}px`,
        );
        await mascotPage.screenshot({
          path: join(output, `stacky-menu-${width}.png`),
          animations: 'disabled',
        });
      }
      await mascotPage.setViewportSize({ width: 1512, height: 982 });
      await helperMenu.getByRole('button', { name: /^My files/ }).click();
      await expect(mascotPage.getByRole('dialog').locator('.file-manager')).toBeVisible();
      await expect(home).toHaveAttribute('data-roaming', 'false');
      await mascotPage.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await expect(helperDraft).toHaveValue('Keep my next idea.');
      await actor.click();
      await helperMenu.getByRole('tab', { name: 'Help', exact: true }).click();
      await helperMenu.getByRole('button', { name: /^Ideas & skills/ }).click();
      await mascotPage
        .getByRole('dialog')
        .getByRole('button', { name: /Review a target/ })
        .waitFor();
      await mascotPage.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await actor.click();
      await helperMenu.getByRole('tab', { name: 'Help', exact: true }).click();
      await helperMenu.getByRole('button', { name: /^Memory/ }).click();
      await mascotPage
        .getByRole('dialog')
        .getByRole('button', { name: /Use Bun for package scripts/ })
        .waitFor();
      await mascotPage.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await expect(helperDraft).toHaveValue('Keep my next idea.');
      assert.equal(
        received.filter((entry) => entry.type === 'user_message').length,
        0,
        'Stacky shortcuts never send the draft',
      );
      await helperDraft.fill('');
      await mascotPage.clock.install();
      await actor.click();
      const stackyMenu = mascotPage.getByRole('dialog', { name: 'Stacky companion', exact: true });
      await stackyMenu
        .getByRole('button', { name: 'Give Stacky a high five', exact: true })
        .click();
      await stackyMenu.getByText('Right back at you!', { exact: true }).waitFor();
      await expect(home).toHaveAttribute('data-gesture', 'highfive');
      await expect(home).toHaveAttribute('data-moving', 'false');
      await mascotPage.screenshot({
        path: join(output, 'stacky-highfive.png'),
        animations: 'allow',
      });
      await stackyMenu.getByRole('button', { name: 'Little dance', exact: true }).click();
      await stackyMenu.getByText('A tiny dance, just for you.', { exact: true }).waitFor();
      await expect(home).toHaveAttribute('data-gesture', 'dance');
      await stackyMenu.getByRole('button', { name: 'Big stretch', exact: true }).click();
      await expect(home).toHaveAttribute('data-gesture', 'stretch');
      await mascotPage.clock.fastForward(2500);
      await expect(home).toHaveAttribute('data-gesture', 'none');
      await stackyMenu.getByText('Tap me for a high five.', { exact: true }).waitFor();
      await stackyMenu.getByRole('tab', { name: 'Comfort', exact: true }).click();
      await mascotPage.getByRole('button', { name: 'Sit quietly', exact: true }).click();
      await expect(home).toHaveAttribute('data-roaming', 'false');
      await actor.click();
      await stackyMenu
        .getByRole('button', { name: 'Give Stacky a high five', exact: true })
        .click();
      await stackyMenu.getByText('A quiet little smile, just for you.', { exact: true }).waitFor();
      assert.equal(
        await stackyMenu
          .locator('.stacky-playground')
          .evaluate((element) => element.getAnimations({ subtree: true }).length),
        0,
        'Quiet mode responds without decorative motion',
      );
      await mascotPage.clock.fastForward(2500);
      await stackyMenu.getByRole('tab', { name: 'Comfort', exact: true }).click();
      await mascotPage.getByRole('button', { name: 'Wander a little', exact: true }).click();
      await mascotPage.getByRole('heading', { name: 'A little idea is enough.' }).click();
      await expect(home).toHaveAttribute('data-roaming', 'true');
      await mascotPage.clock.fastForward(10_100);
      await expect(home).toHaveAttribute('data-moving', 'true');
      await actor.evaluate((element) => {
        for (const animation of element.getAnimations()) animation.finish();
      });
      await mascotPage.clock.runFor(50);
      await expect(home).toHaveAttribute('data-moving', 'false');
      const bounds = await mascotPage.evaluate(() => {
        const actor = document.querySelector('.stacky-companion').getBoundingClientRect();
        const workspace = document.querySelector('.main-workspace').getBoundingClientRect();
        const composer = document.querySelector('.composer-area').getBoundingClientRect();
        const readingLeft = workspace.left + (workspace.width - 848) / 2;
        return {
          actor: { x: actor.x, y: actor.y, right: actor.right, bottom: actor.bottom },
          workspace: { x: workspace.x, y: workspace.y },
          composerTop: composer.top,
          readingLeft,
        };
      });
      assert.ok(
        bounds.actor.x >= bounds.workspace.x && bounds.actor.right < bounds.readingLeft,
        'Stacky stays in the spare gutter',
      );
      assert.ok(bounds.actor.bottom < bounds.composerTop, 'Stacky never covers the composer');
      await mascotPage.screenshot({
        path: join(output, 'stacky-roaming.png'),
        animations: 'allow',
      });
      await mascotPage
        .getByRole('textbox', { name: 'Message', exact: true })
        .fill('Keep my idea while Stacky rests.');
      await expect(home).toHaveAttribute('data-roaming', 'false');
      const paused = await actor.boundingBox();
      await mascotPage.clock.fastForward(11_000);
      assert.deepEqual(await actor.boundingBox(), paused, 'Typing pauses roaming');
      assert.equal(await actor.evaluate((element) => element.getAnimations().length), 0);
      await actor.click();
      await mascotPage.getByRole('button', { name: 'Put Stacky to sleep', exact: true }).click();
      await expect(actor).toHaveCount(0);
      await mascotPage.reload();
      await mascotPage.getByText('Ready', { exact: true }).waitFor();
      await expect(actor).toHaveCount(0);
      await mascotPage.getByRole('button', { name: 'Change workspace view', exact: true }).click();
      await mascotPage
        .getByRole('combobox', { name: 'Little mascot', exact: true })
        .selectOption('quiet');
      await mascotPage.getByRole('button', { name: 'Close view options', exact: true }).click();
      await expect(actor).toBeVisible();
      await expect(home).toHaveAttribute('data-roaming', 'false');
      await mascotPage.emulateMedia({ reducedMotion: 'reduce' });
      await mascotPage.getByRole('button', { name: 'Change workspace view', exact: true }).click();
      await mascotPage
        .getByRole('combobox', { name: 'Little mascot', exact: true })
        .selectOption('roam');
      await mascotPage.getByRole('button', { name: 'Close view options', exact: true }).click();
      await mascotPage.getByRole('heading', { name: 'A little idea is enough.' }).click();
      await expect(home).toHaveAttribute('data-roaming', 'false');
      assert.equal(
        await actor.evaluate((element) => element.getAnimations({ subtree: true }).length),
        0,
        'Reduced motion disables walking and decorative animations',
      );
      await actor.click();
      await stackyMenu.getByRole('button', { name: 'Big stretch', exact: true }).click();
      await stackyMenu.getByText('A quiet little smile, just for you.', { exact: true }).waitFor();
      assert.equal(
        await stackyMenu
          .locator('.stacky-playground')
          .evaluate((element) => element.getAnimations({ subtree: true }).length),
        0,
        'Reduced motion also applies to requested tricks',
      );
      await stackyMenu.getByRole('button', { name: 'Close Stacky menu', exact: true }).click();
      await mascotPage.setViewportSize({ width: 390, height: 844 });
      await expect(actor).toBeInViewport();
      assert.equal(
        await mascotPage.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      await mascotPage.screenshot({
        path: join(output, 'stacky-mobile.png'),
        animations: 'disabled',
      });
      const mascotSocket = [...clients].at(-1);
      frame(mascotSocket, 'provider.text_delta', {
        sessionId: 'session-one',
        text: 'Checking the idea.',
      });
      await expect(home).toHaveAttribute('data-mood', 'working');
      frame(mascotSocket, 'error', {
        sessionId: 'session-one',
        phase: 'provider',
        message: 'Mascot state fixture: needs another look.',
      });
      await expect(home).toHaveAttribute('data-mood', 'attention');
      frame(mascotSocket, 'run.result', {
        sessionId: 'session-one',
        status: 'aborted',
        iterations: 1,
      });
      await expect(home).toHaveAttribute('data-mood', 'stopped');
      frame(mascotSocket, 'run.result', {
        sessionId: 'session-one',
        status: 'done',
        iterations: 1,
      });
      await expect(home).toHaveAttribute('data-mood', 'done');
      frame(mascotSocket, 'agent.status_changed', {
        sessionId: 'session-one',
        subagentId: 'mascot-worker',
        agentName: 'Checking',
        status: 'failed',
      });
      await expect(home).toHaveAttribute('data-mood', 'attention');
      frame(mascotSocket, 'agent.status_changed', {
        sessionId: 'session-one',
        subagentId: 'mascot-worker',
        agentName: 'Checking',
        status: 'running',
      });
      await expect(home).toHaveAttribute('data-mood', 'working');
      frame(mascotSocket, 'agent.status_changed', {
        sessionId: 'session-one',
        subagentId: 'mascot-worker',
        agentName: 'Checking',
        status: 'failed',
      });
      await expect(home).toHaveAttribute('data-mood', 'attention');
      await mascotPage.getByRole('button', { name: 'Change workspace view', exact: true }).click();
      await mascotPage.getByRole('button', { name: /^Just chat/ }).click();
      await expect(actor).toHaveCount(0);
    } finally {
      await mascotPage.close();
    }
  }
  // A fresh browser starts with a friendly chat; optional surfaces never own the draft.
  {
    const cozy = await browser.newPage({ viewport: { width: 1512, height: 982 } });
    cozy.setDefaultTimeout(10_000);
    cozy.on('pageerror', (error) => errors.push(error.message));
    cozy.on('console', (entry) => {
      if (entry.type() === 'error') errors.push(entry.text());
    });
    try {
      await cozy.goto(origin);
      await cozy.getByText('Ready', { exact: true }).waitFor();
      const draft = cozy.getByRole('textbox', { name: 'Message', exact: true });
      const shell = cozy.locator('.vibe-shell');
      await expect(shell).toHaveAttribute('data-view', 'cozy');
      await expect(cozy.locator('.session-sidebar')).not.toBeInViewport();
      assert.equal(await cozy.locator('aside.workspace-panel').count(), 0);
      await expect(
        cozy.getByRole('combobox', { name: 'Reasoning effort', exact: true }),
      ).toHaveCount(1);
      await expect(cozy.getByRole('heading', { name: 'A little idea is enough.' })).toBeVisible();
      await expect(cozy.getByRole('group', { name: 'Choose a starting point' })).not.toBeVisible();
      await cozy.screenshot({
        path: join(output, 'cozy-chat-desktop.png'),
        animations: 'disabled',
      });
      await cozy.getByRole('button', { name: 'Need a little inspiration?', exact: true }).click();
      await cozy.getByLabel('What is your website for?').fill('A tiny garden diary');
      await cozy.getByRole('button', { name: 'Tuck the ideas away', exact: true }).click();
      await cozy.getByRole('button', { name: 'Need a little inspiration?', exact: true }).click();
      await expect(cozy.getByLabel('What is your website for?')).toHaveValue('A tiny garden diary');
      await cozy.getByRole('button', { name: 'Tuck the ideas away', exact: true }).click();
      await draft.fill('Keep my little draft.');
      const changeView = async (name) => {
        await cozy.getByRole('button', { name: 'Change workspace view', exact: true }).click();
        await cozy
          .getByRole('dialog', { name: 'Make yourself at home' })
          .getByRole('button', { name: new RegExp(`^${name}`) })
          .click();
      };
      await cozy.getByRole('button', { name: 'Hide quick shortcuts', exact: true }).click();
      await changeView('Just chat');
      await expect(shell).toHaveAttribute('data-view', 'focus');
      await expect(draft).toHaveValue('Keep my little draft.');
      await expect(cozy.getByRole('navigation', { name: 'Handy shortcuts' })).toHaveCount(0);
      await cozy.reload();
      await cozy.getByText('Ready', { exact: true }).waitFor();
      await expect(shell).toHaveAttribute('data-view', 'focus');
      await expect(draft).toHaveValue('Keep my little draft.');
      await cozy.screenshot({
        path: join(output, 'just-chat-desktop.png'),
        animations: 'disabled',
      });
      await changeView('Studio');
      await expect(cozy.locator('.session-sidebar')).toBeInViewport();
      await expect(cozy.locator('aside.workspace-panel')).toBeVisible();
      await cozy.getByRole('button', { name: 'Close workspace', exact: true }).click();
      await changeView('Cozy chat');
      await expect(cozy.locator('aside.workspace-panel')).toHaveCount(0);
      await expect(draft).toHaveValue('Keep my little draft.');
      await expect(cozy.getByRole('navigation', { name: 'Handy shortcuts' })).toHaveCount(0);
      await cozy.getByRole('button', { name: 'Change workspace view', exact: true }).click();
      await cozy.getByRole('checkbox', { name: 'Quick shortcuts', exact: true }).check();
      await cozy.getByRole('checkbox', { name: 'Helpful introductions', exact: true }).uncheck();
      await cozy.getByRole('button', { name: 'Close view options', exact: true }).click();
      await cozy
        .locator('.header-actions')
        .getByRole('button', { name: 'Files', exact: true })
        .click();
      await expect(cozy.getByRole('heading', { name: 'Your project, within reach' })).toHaveCount(
        0,
      );
      await cozy.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await cozy.getByRole('button', { name: 'Change workspace view', exact: true }).click();
      await cozy.getByRole('checkbox', { name: 'Helpful introductions', exact: true }).check();
      await cozy.getByRole('button', { name: 'Close view options', exact: true }).click();
      await cozy
        .locator('.header-actions')
        .getByRole('button', { name: 'Files', exact: true })
        .click();
      const files = cozy.getByRole('dialog');
      await expect(files.locator('.file-manager')).toHaveAttribute('data-layout', 'single');
      await expect(files.getByRole('button', { name: 'notes.md', exact: true })).toBeVisible();
      await expect(files.getByRole('group', { name: 'File types' })).not.toBeVisible();
      await files.getByRole('button', { name: 'Hide files introduction', exact: true }).click();
      await cozy.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await cozy
        .locator('.header-actions')
        .getByRole('button', { name: 'Files', exact: true })
        .click();
      await files.getByRole('button', { name: 'Show files introduction', exact: true }).click();
      await files.getByRole('button', { name: 'Find by file type', exact: true }).click();
      await files
        .getByRole('group', { name: 'File types' })
        .getByRole('button', { name: /^Documents/ })
        .click();
      await files.getByRole('button', { name: 'notes.md', exact: true }).click();
      await files.getByRole('button', { name: 'Pin this file', exact: true }).click();
      await expect(
        files.getByRole('button', { name: 'Unpin this file', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(
        files.getByRole('complementary', { name: 'Directories and files' }),
      ).not.toBeVisible();
      await expect(files.getByRole('button', { name: 'Browse files', exact: true })).toBeVisible();
      await files.getByRole('button', { name: 'Use split file view', exact: true }).click();
      await expect(
        files.getByRole('complementary', { name: 'Directories and files' }),
      ).toBeVisible();
      await files
        .locator('.file-content')
        .getByRole('button', { name: 'Use single file view', exact: true })
        .click();
      await files.getByRole('button', { name: 'Browse files', exact: true }).click();
      await expect(
        files.getByRole('navigation', { name: 'Pinned files', exact: true }),
      ).toBeVisible();
      await files.getByRole('button', { name: 'Clear search and filters', exact: true }).click();
      await files.getByRole('button', { name: 'src/app.tsx', exact: true }).click();
      await expect(files.getByRole('button', { name: 'Pin this file', exact: true })).toBeEnabled();
      await files.getByRole('button', { name: 'Browse files', exact: true }).click();
      await expect(
        files.getByRole('button', { name: 'Open recent src/app.tsx', exact: true }),
      ).toBeVisible();
      for (const width of [320, 390]) {
        await cozy.setViewportSize({ width, height: 844 });
        assert.equal(
          await files.evaluate((element) => element.scrollWidth > element.clientWidth),
          false,
          `Handy files fit at ${width}px`,
        );
        await expect(
          files.getByRole('button', { name: 'Open pinned notes.md', exact: true }),
        ).toBeVisible();
        await cozy.screenshot({
          path: join(output, `handy-files-${width}.png`),
          animations: 'disabled',
        });
      }
      await cozy.setViewportSize({ width: 1512, height: 982 });
      await files.getByRole('button', { name: 'Clear recent shortcuts', exact: true }).click();
      await expect(
        files.getByRole('navigation', { name: 'Recent files', exact: true }),
      ).toHaveCount(0);
      await expect(
        files.getByRole('navigation', { name: 'Pinned files', exact: true }),
      ).toBeVisible();
      await files.locator('.file-shelf > summary').click();
      await expect(files.locator('.file-shelf')).not.toHaveAttribute('open', '');
      await cozy.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await cozy
        .locator('.header-actions')
        .getByRole('button', { name: 'Files', exact: true })
        .click();
      await expect(files.locator('.file-shelf')).not.toHaveAttribute('open', '');
      await files.locator('.file-shelf > summary').click();
      await cozy.screenshot({ path: join(output, 'cozy-files.png'), animations: 'disabled' });
      await cozy.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await cozy.getByRole('button', { name: 'Ideas & skills', exact: true }).click();
      const library = cozy.getByRole('dialog');
      await expect(library.getByRole('group', { name: 'Library filters' })).not.toBeVisible();
      await expect(library.getByRole('tab', { name: 'Tools', exact: true })).toHaveCount(0);
      await expect(library.getByRole('tab', { name: 'Connections', exact: true })).toHaveCount(0);
      await library
        .getByRole('button', { name: 'Show more library sections', exact: true })
        .click();
      await expect(library.getByRole('tab', { name: 'Tools', exact: true })).toBeVisible();
      await library.getByRole('tab', { name: 'Connections', exact: true }).click();
      await expect(library.getByRole('tab', { name: 'Connections', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      for (const width of [320, 390]) {
        await cozy.setViewportSize({ width, height: 844 });
        assert.equal(
          await library.evaluate((element) => element.scrollWidth > element.clientWidth),
          false,
          `Expanded library sections fit at ${width}px`,
        );
        await expect(
          library.getByRole('button', { name: 'Show fewer library sections', exact: true }),
        ).toBeVisible();
      }
      await cozy.setViewportSize({ width: 1512, height: 982 });
      await library
        .getByRole('button', { name: 'Show fewer library sections', exact: true })
        .click();
      await expect(library.getByRole('tab', { name: 'Ideas', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(library.getByRole('tab', { name: 'Connections', exact: true })).toHaveCount(0);
      await library
        .getByRole('group', { name: 'Collection display' })
        .getByRole('button', { name: 'List', exact: true })
        .click();
      await expect(cozy.locator('html')).toHaveAttribute('data-collection-view', 'list');
      await library.getByRole('button', { name: /Review a target/ }).click();
      await expect(library.getByRole('navigation', { name: 'Prompts list' })).not.toBeVisible();
      await library.getByRole('button', { name: 'All prompts', exact: true }).click();
      await expect(library.getByRole('navigation', { name: 'Prompts list' })).toBeVisible();
      await cozy.screenshot({ path: join(output, 'cozy-library.png'), animations: 'disabled' });
      await cozy.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await cozy
        .getByRole('navigation', { name: 'Handy shortcuts' })
        .getByRole('button', { name: 'Memory', exact: true })
        .click();
      const memories = cozy.getByRole('dialog');
      await expect(
        memories
          .getByRole('group', { name: 'Collection display' })
          .getByRole('button', { name: 'List', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
      await memories
        .getByRole('group', { name: 'Collection display' })
        .getByRole('button', { name: 'Cards', exact: true })
        .click();
      await memories.getByRole('button', { name: /Use Bun for package scripts/ }).click();
      await expect(memories.getByRole('navigation', { name: 'Memory records' })).not.toBeVisible();
      await memories.getByRole('button', { name: 'All memories', exact: true }).click();
      await expect(memories.getByRole('navigation', { name: 'Memory records' })).toBeVisible();
      await cozy.getByRole('button', { name: 'Close dialog', exact: true }).click();
      await cozy.keyboard.press('Control+,');
      const cozySettings = cozy.getByRole('dialog', { name: 'Settings', exact: true });
      // The toHaveCount(0) checks below also pass before the dialog opens; wait for it so
      // the screenshot never catches the shortcut half-way.
      await cozySettings.getByRole('textbox', { name: 'Search settings', exact: true }).waitFor();
      // The Memory dialog closed just before; capture only once it is gone and the Settings
      // surface has finished arriving.
      await cozy.waitForFunction(
        () =>
          document.querySelectorAll('[role="dialog"]').length === 1 &&
          document.getAnimations().every((animation) => animation.playState !== 'running'),
        undefined,
        { polling: 50 },
      );
      await expect(
        cozySettings.getByRole('combobox', { name: 'Working mode', exact: true }),
      ).toHaveCount(0);
      await expect(cozySettings.locator('.modal-heading .detail-switch')).toHaveCount(0);
      await cozy.screenshot({ path: join(output, 'cozy-settings.png'), animations: 'disabled' });
      await cozySettings
        .getByRole('textbox', { name: 'Search settings', exact: true })
        .fill('Compaction strategy');
      await cozySettings
        .getByRole('region', { name: 'Matching settings' })
        .getByRole('button', { name: /^Compaction strategy/ })
        .click();
      await expect(
        cozySettings.getByRole('combobox', { name: 'Compaction strategy', exact: true }),
      ).toBeVisible();
      await cozySettings.getByText('A little more control', { exact: true }).click();
      await expect(
        cozySettings.getByRole('combobox', { name: 'Compaction strategy', exact: true }),
      ).toHaveCount(0);
      await cozy.getByRole('button', { name: 'Close dialog', exact: true }).click();
      for (const width of [320, 390, 768]) {
        await cozy.setViewportSize({ width, height: 844 });
        assert.equal(
          await cozy.evaluate(() => document.documentElement.scrollWidth > innerWidth),
          false,
          `Cozy chat fits at ${width}px`,
        );
        await cozy.screenshot({
          path: join(output, `cozy-chat-${width}.png`),
          animations: 'disabled',
        });
      }
      await cozy.setViewportSize({ width: 1512, height: 982 });
      const cozySocket = [...clients].at(-1);
      frame(cozySocket, 'provider.text_delta', {
        sessionId: 'session-one',
        text: 'Taking a look at your idea.',
      });
      frame(cozySocket, 'tool.started', {
        sessionId: 'session-one',
        id: 'cozy-tool',
        name: 'read_file',
        input: { path: 'notes.md' },
      });
      await cozy.getByRole('button', { name: 'Stop all', exact: true }).waitFor();
      await expect(cozy.getByRole('list', { name: 'Recent tool calls' })).not.toBeVisible();
      await cozy.getByText('A peek behind the scenes', { exact: true }).click();
      await expect(cozy.getByRole('list', { name: 'Recent tool calls' })).toBeVisible();
      await changeView('Just chat');
      await expect(cozy.getByRole('button', { name: 'Stop all', exact: true })).toBeVisible();
      await expect(draft).toHaveValue('Keep my little draft.');
      await cozy.getByRole('button', { name: 'Stop all', exact: true }).click();
      await cozy.getByRole('dialog').getByRole('button', { name: 'Stop all', exact: true }).click();
      await cozy.getByText('Work stopped', { exact: true }).waitFor();
      assert.equal(
        received.filter((entry) => entry.type === 'user_message').length,
        0,
        'Appearance changes and cozy browsing never send a message',
      );
    } finally {
      await cozy.close();
    }
  }
  await page.goto(origin);
  await page.getByRole('button', { name: 'Send message', exact: true }).waitFor();
  await page.getByText('What are we building').waitFor();
  await page.getByText('Ready', { exact: true }).waitFor();
  await page.locator('.workspace-artwork').waitFor();
  assert.equal(await page.locator('.workspace-artwork').getAttribute('aria-hidden'), 'true');
  // The friendly launchpad prepares editable messages, preserving the user's work.
  const launchMessage = page.getByRole('textbox', { name: 'Message', exact: true });
  const sentBeforeLaunch = received.filter((entry) => entry.type === 'user_message').length;
  await launchMessage.fill('Keep my own idea too.');
  await page.getByRole('button', { name: /A useful little app/ }).click();
  await page.getByLabel('What should your app help people do?').fill('Track my reading goals');
  await page.getByRole('button', { name: 'Playful & friendly', exact: true }).click();
  await page.getByRole('button', { name: 'Add to my message', exact: true }).click();
  await expect(launchMessage).toHaveValue(
    /Keep my own idea too\.[\s\S]*Track my reading goals[\s\S]*Playful & friendly/,
  );
  await expect(launchMessage).toBeFocused();
  assert.equal(
    received.filter((entry) => entry.type === 'user_message').length,
    sentBeforeLaunch,
    'A starter never sends or starts work',
  );
  await launchMessage.fill('');
  await page.getByRole('button', { name: /Make this project better/ }).click();
  await page.getByRole('button', { name: 'More visual', exact: true }).click();
  assert.equal(
    await page
      .getByRole('button', { name: 'More visual', exact: true })
      .getAttribute('aria-pressed'),
    'true',
    'Selecting a direction marks it pressed',
  );
  await page.getByRole('button', { name: 'More visual', exact: true }).click();
  assert.equal(
    await page
      .getByRole('button', { name: 'More visual', exact: true })
      .getAttribute('aria-pressed'),
    'false',
    'Clicking the selected direction again clears it',
  );
  await page.getByRole('button', { name: /A beautiful website/ }).click();
  assert.equal(
    await page
      .getByRole('button', { name: 'Clean & minimal', exact: true })
      .getAttribute('aria-pressed'),
    'false',
    'Changing the project type clears the previous direction',
  );
  await page.getByLabel('What is your website for?').fill('   ');
  await page.getByRole('button', { name: 'Add to my message', exact: true }).click();
  await expect(launchMessage).toHaveValue(/^Help me create a website\.\nFirst, ask me/);
  assert.equal(received.filter((entry) => entry.type === 'user_message').length, sentBeforeLaunch);
  await launchMessage.fill('');
  await page.getByLabel('What is your website for?').fill('');
  const experience = page.locator('.experience-bar');
  await experience.getByRole('button', { name: 'Extended', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View context', exact: true })).toContainText(
    '128K',
  );
  assert.equal(
    await page.evaluate(() => localStorage.getItem('wrongstack.vibeui.detail')),
    'extended',
  );
  await experience.getByRole('button', { name: 'Simple', exact: true }).click();
  await expect(page.getByRole('button', { name: 'View context', exact: true })).toContainText(
    'Conversation space',
  );
  await page.getByRole('button', { name: 'Quick tour', exact: true }).click();
  await page.getByRole('heading', { name: 'A little help getting started' }).waitFor();
  for (const step of [
    'Tell us what you have in mind',
    'Show the feeling you’re after',
    'Review, then keep shaping',
  ]) {
    await expect(page.getByText(step, { exact: true })).toBeVisible();
  }
  await expect(
    page.getByText(
      '“I’d like a welcoming website for my flower shop. Help me figure out what it needs.”',
      { exact: true },
    ),
  ).toBeVisible();
  await page.screenshot({
    path: join(output, 'getting-started-desktop.png'),
    animations: 'disabled',
  });
  await captureNarrowDialog('getting-started');
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'A little help getting started' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Quick tour', exact: true }).click();
  await page.getByRole('heading', { name: 'A little help getting started' }).waitFor();
  await page.getByRole('button', { name: 'Let’s make something', exact: true }).click();
  await expect(launchMessage).toBeFocused();
  await page.getByRole('button', { name: 'Quick tour', exact: true }).click();
  await page.getByRole('button', { name: 'See changes', exact: true }).click();
  await expect(page.getByRole('tab', { name: /Changes/ })).toHaveAttribute('data-state', 'active');
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  await page.getByRole('button', { name: 'Quick tour', exact: true }).click();
  await page.getByRole('button', { name: 'Adjust my experience', exact: true }).click();
  await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.locator('.conversation').evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(page.getByRole('button', { name: 'Latest', exact: true })).toHaveCount(0);
  await page.screenshot({
    path: join(output, 'welcome-desktop-dark.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Use light theme', exact: true }).click();
  await page.screenshot({
    path: join(output, 'welcome-desktop-light.png'),
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Use dark theme', exact: true }).click();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(
    await page
      .locator('.concept-chart i')
      .first()
      .evaluate((element) => getComputedStyle(element).animationName),
    'none',
    'Reduced motion disables the new concept animations',
  );
  assert.equal(
    await page
      .locator('.art-main-panel')
      .evaluate((element) => getComputedStyle(element).animationName),
    'none',
    'Reduced motion disables decorative SVG movement',
  );
  assert.equal(
    await page.locator('.welcome').evaluate((element) => getComputedStyle(element).animationName),
    'none',
  );
  await page.getByRole('button', { name: 'Toggle workspace', exact: true }).click();
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await page.locator('.conversation').evaluate((element) => {
      element.scrollTop = 0;
    });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `Welcome fits at ${width}px`,
    );
    await page.screenshot({
      path: join(output, `welcome-${width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.getByRole('button', { name: 'Toggle workspace', exact: true }).click();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.getByRole('button', { name: 'fixture-model' }).waitFor();
  await page.getByRole('button', { name: 'fixture-model' }).click();
  await page.getByRole('option', { name: /Small model/ }).click();
  await page.getByRole('heading', { name: 'A smaller context window' }).waitFor();
  await page.getByRole('button', { name: 'Keep current model', exact: true }).click();
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox', { name: 'Search models', exact: true }).fill('Small');
  await page.getByRole('combobox', { name: 'Search models', exact: true }).press('Enter');
  await page.getByRole('button', { name: 'Switch model', exact: true }).click();
  await page.getByRole('button', { name: 'small-model', exact: true }).waitFor();
  await page.getByRole('combobox', { name: 'Reasoning effort', exact: true }).selectOption('high');
  await page.waitForFunction(
    () => document.querySelector('select[aria-label="Reasoning effort"]')?.value === 'high',
  );
  assert.ok(
    received.some(
      (m) =>
        m.type === 'prefs.update' &&
        m.payload.sessionId === 'session-one' &&
        m.payload.reasoningEffort === 'high',
    ),
  );
  await page.getByRole('button', { name: 'Agent settings', exact: true }).click();
  const settings = page.getByRole('dialog');
  for (const mode of ['plus', 'on', 'plus', 'off']) {
    await settings.getByRole('combobox', { name: 'YOLO mode', exact: true }).selectOption(mode);
    await page.waitForFunction(
      (value) => document.querySelector('select[aria-label="YOLO mode"]')?.value === value,
      mode,
    );
    const update = received.filter((frame) => frame.type === 'prefs.update').at(-1);
    assert.equal(update.payload.sessionId, 'session-one');
    assert.equal(update.payload.yolo, mode !== 'off');
    assert.equal(update.payload.yoloPlus, mode === 'plus');
    const summary = await page
      .getByRole('button', { name: 'Agent settings', exact: true, includeHidden: true })
      .textContent();
    assert.equal(summary.includes('YOLO+'), mode === 'plus');
    if (mode === 'plus')
      await settings
        .getByText('Approve all calls, including subagents. Explicit deny rules still apply.', {
          exact: true,
        })
        .waitFor();
  }
  await settings.getByRole('combobox', { name: 'YOLO mode', exact: true }).selectOption('on');
  await page.waitForFunction(
    () => document.querySelector('select[aria-label="YOLO mode"]')?.value === 'on',
  );
  await settings.getByRole('combobox', { name: 'Autonomy', exact: true }).selectOption('auto');
  await page.waitForFunction(
    () => document.querySelector('select[aria-label="Autonomy"]')?.value === 'auto',
  );
  await settings.getByRole('combobox', { name: 'Autonomy', exact: true }).selectOption('suggest');
  await settings
    .getByRole('combobox', { name: 'Next steps policy', exact: true })
    .selectOption('required');
  await settings.getByRole('combobox', { name: 'Working mode', exact: true }).selectOption('plan');
  await page.waitForFunction(
    () => document.querySelector('select[aria-label="Working mode"]')?.value === 'plan',
  );
  for (const [label, palette] of [
    ['Forest', 'sage'],
    ['Amber', 'amber'],
    ['Violet', 'violet'],
    ['Ocean', 'ocean'],
  ]) {
    await settings.getByRole('button', { name: label, exact: true }).click();
    assert.equal(await page.locator('html').getAttribute('data-palette'), palette);
    await auditTheme();
    await settings.getByRole('button', { name: 'Light', exact: true }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light');
    await auditTheme();
    await page.screenshot({
      path: join(output, `settings-light-${palette}.png`),
      fullPage: true,
      animations: 'disabled',
    });
    await settings.getByRole('button', { name: 'Dark', exact: true }).click();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  }
  assert.equal(await page.locator('html').getAttribute('data-palette'), 'ocean');
  await settings.getByRole('combobox', { name: 'YOLO mode', exact: true }).selectOption('off');
  await page.waitForFunction(
    () => document.querySelector('select[aria-label="YOLO mode"]')?.value === 'off',
  );
  await settings.getByText(`VibeUI v${uiVersion} · WrongStack v1.1.7`, { exact: true }).waitFor();
  await page.screenshot({
    path: join(output, 'runtime-settings.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await captureNarrowDialog('runtime-settings');
  await settings.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page
    .locator('.workspace-navigation')
    .getByRole('button', { name: 'Providers', exact: true })
    .click();
  const accounts = page.getByRole('dialog');
  await accounts.getByText('fx...last', { exact: true }).waitFor();
  await page.screenshot({
    path: join(output, 'provider-cards.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await accounts
    .getByRole('textbox', { name: 'Search saved providers', exact: true })
    .fill('not-a-real-account');
  await accounts
    .getByText('No accounts match “not-a-real-account”. Try another name.', { exact: true })
    .waitFor();
  await accounts.getByRole('textbox', { name: 'Search saved providers', exact: true }).fill('');
  await accounts.getByText('fx...last', { exact: true }).waitFor();
  await accounts
    .getByRole('button', { name: 'Delete key provider from fixture', exact: true })
    .click();
  await accounts.getByRole('button', { name: 'Confirm removal', exact: true }).click();
  await accounts.getByText('Key removed.', { exact: true }).waitFor();
  assert.ok(received.some((m) => m.type === 'key.delete' && m.payload.label === 'provider'));
  assert.equal(
    received.some((m) => m.type === 'provider.remove'),
    false,
    'A key named provider must never remove its account',
  );
  await accounts.getByRole('tab', { name: 'API key', exact: true }).click();
  await accounts
    .getByRole('combobox', { name: 'API key provider', exact: true })
    .selectOption('fixture');
  await accounts.getByRole('textbox', { name: 'Provider alias', exact: true }).fill('bad-provider');
  await accounts
    .getByRole('textbox', { name: 'New provider API key', exact: true })
    .fill('fixture-secret');
  await accounts.getByRole('button', { name: 'Save provider', exact: true }).click();
  await accounts.getByText('Fixture credential validation failed.', { exact: true }).waitFor();
  await accounts
    .getByRole('textbox', { name: 'Provider alias', exact: true })
    .fill('second-account');
  await accounts.getByRole('button', { name: 'Save provider', exact: true }).click();
  await accounts.getByText('second-account', { exact: true }).waitFor();
  assert.equal(
    ((await accounts.textContent()) ?? '').includes('fixture-secret'),
    false,
    'Credentials must stay masked',
  );
  await accounts.getByRole('tab', { name: 'Custom endpoint', exact: true }).click();
  await accounts.getByRole('textbox', { name: 'Provider alias', exact: true }).fill('local-test');
  await accounts
    .getByRole('textbox', { name: 'Provider model IDs', exact: true })
    .fill('local-one, local-two');
  await accounts.getByRole('button', { name: 'Save provider', exact: true }).click();
  await accounts.getByText('local-test', { exact: true }).waitFor();
  assert.deepEqual(
    received.find((m) => m.type === 'provider.add' && m.payload.id === 'local-test').payload.models,
    ['local-one', 'local-two'],
  );
  await accounts.getByRole('tab', { name: 'Subscription login', exact: true }).click();
  await accounts.getByRole('button', { name: 'Sign in to OpenAI / ChatGPT', exact: true }).click();
  await accounts.getByRole('link', { name: 'Open sign-in page', exact: false }).waitFor();
  assert.equal(
    await accounts
      .getByRole('link', { name: 'Open sign-in page', exact: false })
      .getAttribute('href'),
    'https://example.com/oauth',
  );
  await accounts
    .getByRole('textbox', { name: 'Authorization code', exact: true })
    .fill('fixture-code');
  await accounts.getByRole('button', { name: 'Submit code', exact: true }).click();
  await accounts.getByText('Fixture account signed in.', { exact: true }).waitFor();
  await accounts.getByRole('tab', { name: 'Subscription login', exact: true }).click();
  await accounts
    .getByRole('textbox', { name: 'Account alias', exact: true })
    .fill('cancelled-sign-in');
  await accounts.getByRole('button', { name: 'Sign in to OpenAI / ChatGPT', exact: true }).click();
  await accounts.getByRole('link', { name: 'Open sign-in page', exact: false }).waitFor();
  await page.screenshot({
    path: join(output, 'providers-accounts.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await captureNarrowDialog('providers-accounts');
  await accounts.getByRole('button', { name: 'Close dialog', exact: true }).click();
  assert.ok(
    received.some((m) => m.type === 'auth.oauth.cancel' && m.payload.kind === 'fixture-chatgpt'),
  );
  for (const [type, key, value] of [
    ['autonomy.switch', 'mode', 'auto'],
    ['prefs.update', 'yolo', true],
    ['mode.switch', 'id', 'plan'],
  ])
    assert.ok(
      received.some(
        (m) => m.type === type && m.payload.sessionId === 'session-one' && m.payload[key] === value,
      ),
    );
  await page.getByRole('button', { name: 'View context', exact: true }).click();
  const context = page.getByRole('dialog');
  await context.getByText('Session input', { exact: true }).waitFor();
  await context.getByText(/12[,.]345/).waitFor();
  assert.equal(
    received.some((m) => m.type === 'context.editor.open'),
    false,
    'Simple context must not load full conversation contents',
  );
  await page.screenshot({
    path: join(output, 'context-simple.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await captureNarrowDialog('context-simple');
  await context.getByRole('button', { name: 'Extended', exact: true }).click();
  await context.locator('summary').filter({ hasText: 'Runtime-only context entry' }).waitFor();
  assert.equal(await context.getByText('Foreign secret should not appear').count(), 0);
  await context.getByText(/90[,.]000 tokens/).waitFor();
  await context
    .getByRole('textbox', { name: 'Search context', exact: true })
    .fill('missing context');
  await context.getByText('No matching context messages.', { exact: true }).waitFor();
  await context.getByRole('textbox', { name: 'Search context', exact: true }).fill('');
  await context
    .locator('summary')
    .filter({ hasText: /^System instructions$/ })
    .click();
  await context
    .getByText('Actual session instructions from the runtime', { exact: true })
    .waitFor();
  await page.screenshot({
    path: join(output, 'context-window.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await context.getByRole('button', { name: 'Compact now', exact: true }).click();
  await context.getByRole('button', { name: 'Compacting…', exact: true }).waitFor();
  await context.locator('summary').filter({ hasText: 'Compacted runtime context' }).waitFor();
  assert.ok(
    received.some((m) => m.type === 'context.compact' && m.payload.sessionId === 'session-one'),
  );
  await context.getByRole('button', { name: 'Simple', exact: true }).click();
  await context.getByRole('button', { name: 'Close dialog', exact: true }).click();
  for (const client of clients)
    frame(client, 'tool.confirm_needed', {
      sessionId: 'session-one',
      id: 'permission',
      toolName: 'write_file',
      input: { path: 'src/app.tsx' },
      suggestedPattern: 'write_file',
    });
  await page.getByRole('heading', { name: 'Your permission is needed' }).waitFor();
  await page.getByRole('button', { name: 'Allow once', exact: true }).click();
  await page
    .getByRole('heading', { name: 'Your permission is needed' })
    .waitFor({ state: 'hidden' });
  assert.ok(
    received.some(
      (m) =>
        m.type === 'tool.confirm_result' &&
        m.payload.id === 'permission' &&
        m.payload.decision === 'yes',
    ),
  );
  for (const client of clients)
    frame(client, 'user.input_requested', {
      sessionId: 'session-one',
      request: {
        id: 'question',
        title: 'Choose a direction',
        tabs: [
          {
            id: 'tab',
            label: 'Direction',
            questions: [
              {
                id: 'q',
                prompt: 'Which version?',
                kind: 'single_select',
                required: true,
                allowCustomResponse: false,
                options: [{ id: 'small', label: 'Keep it small' }],
              },
            ],
          },
        ],
      },
    });
  await page.getByRole('heading', { name: 'Choose a direction', exact: true }).waitFor();
  // A second request queued behind the first is announced, not hidden.
  for (const client of clients)
    frame(client, 'user.input_requested', {
      sessionId: 'session-one',
      request: {
        id: 'question-two',
        title: 'Second question',
        tabs: [{ id: 'tab', label: 'Tab', questions: [] }],
      },
    });
  await page.getByText('1 more question is waiting after this one.', { exact: true }).waitFor();
  for (const client of clients)
    frame(client, 'user.input_resolved', { sessionId: 'session-one', requestId: 'question-two' });
  await page
    .getByText('1 more question is waiting after this one.', { exact: true })
    .waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Send answer', exact: true }).click();
  await page.getByText('Please answer the required questions.').waitFor();
  await page.getByRole('radio', { name: 'Keep it small', exact: true }).check();
  await page.getByRole('button', { name: 'Send answer', exact: true }).click();
  await page
    .getByRole('heading', { name: 'Choose a direction', exact: true })
    .waitFor({ state: 'hidden' });
  await page.screenshot({
    path: `${output}/desktop-dark.png`,
    fullPage: true,
    animations: 'disabled',
  });
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  const compactDraftHeight = (await message.boundingBox()).height;
  await message.fill(
    Array.from({ length: 24 }, (_, index) => `Draft line ${index + 1}`).join('\n'),
  );
  await page.waitForFunction(
    (height) => document.querySelector('textarea[aria-label="Message"]').clientHeight > height + 30,
    compactDraftHeight,
  );
  assert.ok(
    (await message.boundingBox()).height <= 231,
    'Long drafts grow within a bounded editor',
  );
  await message.fill('Short draft');
  await page.waitForFunction(
    (height) => document.querySelector('textarea[aria-label="Message"]').clientHeight <= height + 2,
    compactDraftHeight,
  );
  await message.fill('Fail refinement');
  await page.getByRole('button', { name: 'Refine prompt', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByText('Fixture refiner unavailable', { exact: true })
    .waitFor();
  await page.getByRole('button', { name: 'Keep original', exact: true }).click();
  assert.equal(await message.inputValue(), 'Fail refinement');
  await message.fill('Explain $tes');
  await page.getByRole('option', { name: /\$testing/ }).waitFor();
  assert.equal(await page.getByRole('option', { name: /wrong-skill/ }).count(), 0);
  await message.press('Tab');
  assert.equal(await message.inputValue(), 'Explain $testing ');
  await message.fill(`${await message.inputValue()}@app`);
  await page.getByRole('option', { name: 'src/app.tsx', exact: true }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: 'pixel.png',
    mimeType: 'image/png',
    buffer: Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6N0AAAAASUVORK5CYII=',
      'base64',
    ),
  });
  await page.getByRole('button', { name: 'Remove pixel.png', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Refine prompt', exact: true }).click();
  await page.getByRole('textbox', { name: 'Refined prompt', exact: true }).waitFor();
  await page.getByText('Refined with fixture / refiner-model', { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole('dialog')
      .locator('.refiner-original')
      .evaluate((element) => element.open),
    false,
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Extended', exact: true }).click();
  assert.equal(
    await page
      .getByRole('dialog')
      .locator('.refiner-original')
      .evaluate((element) => element.open),
    true,
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Simple', exact: true }).click();
  await page.screenshot({
    path: join(output, 'prompt-refiner.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await captureNarrowDialog('prompt-refiner');
  await page.getByRole('button', { name: 'Use refined', exact: true }).click();
  assert.equal(await message.inputValue(), '$testing\n\nExplain the project clearly.');
  assert.equal(
    received.filter((m) => m.type === 'user_message').length,
    0,
    'Refining must never send a chat message',
  );
  await page.getByRole('button', { name: 'Remove pixel.png', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Remove src/app.tsx', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Queue message', exact: true }).waitFor();
  await message.fill('And explain the tests');
  await page.getByRole('button', { name: 'Queue message', exact: true }).click();
  await page.getByText('And explain the tests', { exact: false }).first().waitFor();
  await page.getByRole('button', { name: 'Resume queue', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('.message-assistant').length === 2 &&
      !document.querySelector('.working-line'),
  );
  assert.equal(received.filter((m) => m.type === 'user_message').length, 2);
  assert.equal(
    received.find((m) => m.type === 'user_message').payload.images[0].mediaType,
    'image/png',
  );
  assert.equal(
    received.find((m) => m.type === 'user_message').payload.content,
    '$testing\n\nExplain the project clearly.\n@src/app.tsx',
  );
  await page.getByRole('button', { name: 'Edit step 1 in composer', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('textarea[aria-label="Message"]')?.value ===
      'Review keyboard navigation',
  );
  assert.equal(
    received.filter((m) => m.type === 'user_message').length,
    2,
    'Selecting next steps restores a draft without automatic execution',
  );
  await message.fill('Fail safely');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await message.fill('Keep queued after error');
  await page.getByRole('button', { name: 'Queue message', exact: true }).click();
  await message.fill('Second queued task');
  await page.getByRole('button', { name: 'Queue message', exact: true }).click();
  await page.getByRole('button', { name: 'Resume queue', exact: true }).waitFor();
  assert.equal(
    received.filter((m) => m.type === 'user_message').length,
    3,
    'A failed run must not drain queued messages',
  );
  await page.getByRole('button', { name: 'Move queued message 2 up', exact: true }).click();
  await page.getByRole('button', { name: 'Edit queued message 2', exact: true }).click();
  assert.equal(await message.inputValue(), 'Keep queued after error');
  await page.getByRole('button', { name: 'Resume queue', exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector('.working-line') && !document.querySelector('.message-queue'),
  );
  assert.equal(
    received.filter((m) => m.type === 'user_message').at(-1).payload.content,
    'Second queued task',
  );
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.working-line'));
  assert.equal(received.filter((m) => m.type === 'user_message').length, 5);
  await message.fill('Start before steering');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'View context', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Compact now', exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Compact now', exact: true })
      .isDisabled(),
    true,
    'Cannot compact during an active run',
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('combobox', { name: 'Message delivery', exact: true }).selectOption('steer');
  await page.setViewportSize({ width: 390, height: 844 });
  await pinConversation();
  await page.screenshot({
    path: join(output, 'mobile-queue.png'),
    fullPage: true,
    animations: 'disabled',
  });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'Running composer controls must fit mobile',
  );
  await page.setViewportSize({ width: 1512, height: 982 });
  // Narrow viewports close the workspace panel; reopen it for the desktop checks below.
  if (!(await page.locator('aside.workspace-panel').isVisible()))
    await page.getByRole('button', { name: 'Toggle workspace', exact: true }).click();
  await message.fill('Change direction now');
  await page.getByRole('button', { name: 'Steer message', exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector('.working-line') && !document.querySelector('.message-queue'),
  );
  assert.equal(
    received.filter((m) => m.type === 'user_message').at(-1).payload.content,
    'Change direction now',
  );
  assert.equal(
    received.filter((m) => m.type === 'user_message').length,
    7,
    'Steering dispatches exactly once after the aborted-run boundary',
  );
  assert.ok(received.some((m) => m.type === 'abort' && m.payload.sessionId === 'session-one'));
  await page.getByRole('button', { name: 'Session actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Rename session', exact: true }).click();
  await page.getByRole('textbox', { name: 'Session name', exact: true }).fill('Focused workspace');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.header-project strong')?.textContent === 'Focused workspace',
  );
  await page.getByRole('button', { name: 'Session actions', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('menuitem', { name: 'Export conversation', exact: true }).click();
  const download = await downloadPromise;
  assert.equal(await download.failure(), null, 'Conversation download must complete');
  await download.saveAs(join(output, 'conversation.md'));
  assert.ok(
    (await readFile(join(output, 'conversation.md'), 'utf8')).includes('Keep queued after error'),
  );
  await page.getByRole('tab', { name: /Changes/ }).click();
  await page.getByRole('button', { name: 'src/app.tsx', exact: false }).click();
  await page.getByText('export const greeting = "hello, world";', { exact: false }).waitFor();
  await pinConversation();
  await page.screenshot({
    path: join(output, 'diff-modal.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await captureNarrowDialog('diff-modal', { pin: true });
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('tab', { name: 'Tasks', exact: true }).click();
  await page.getByText('Build a focused workspace').waitFor();
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  await page.getByText('read_file', { exact: true }).first().waitFor();
  await pinConversation();
  await page.screenshot({
    path: join(output, 'workspace-redesign.png'),
    fullPage: true,
    animations: 'disabled',
  });
  const toolCard = page.locator('.tool-card').filter({ hasText: 'read_file' }).first();
  await toolCard.locator('summary').click();
  assert.equal(await toolCard.locator('pre').count(), 0, 'Sidebar keeps tool details compact');
  await toolCard.getByRole('button', { name: 'Inspect call', exact: true }).click();
  const toolDialog = page.getByRole('dialog');
  await toolDialog.getByText('File inspected.', { exact: true }).waitFor();
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await toolDialog.getByRole('button', { name: 'Copy tool result', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'File inspected.');
  await toolDialog.getByRole('tab', { name: 'Arguments', exact: true }).click();
  await toolDialog.getByRole('region', { name: 'Arguments JSON tree', exact: true }).waitFor();
  await toolDialog.getByText('"src/app.tsx"', { exact: true }).waitFor();
  await toolDialog.getByRole('button', { name: 'Formatted', exact: true }).click();
  await toolDialog.locator('pre').filter({ hasText: 'src/app.tsx' }).waitFor();
  await toolDialog.getByRole('button', { name: 'Extended', exact: true }).click();
  await toolDialog.getByText(/Call ID · tool-/).waitFor();
  await pinConversation();
  await page.screenshot({
    path: join(output, 'tool-inspector.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await captureNarrowDialog('tool-inspector', { pin: true });
  await toolDialog.getByRole('button', { name: 'Simple', exact: true }).click();
  await toolDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();

  // Structured tool results render as a lossless JSON tree, with formatted/raw alternatives.
  const structuredResult =
    '{"path":"src/app.tsx","ok":true,"count":9007199254740993,"files":[{"name":"a.ts","lines":42}],"message":"first\\nsecond","empty":[]}';
  for (const client of clients) {
    frame(client, 'tool.started', {
      sessionId: 'session-one',
      id: 'structured-proof',
      name: 'structured_result',
      input: { query: 'readable results' },
    });
    frame(client, 'tool.executed', {
      sessionId: 'session-one',
      id: 'structured-proof',
      name: 'structured_result',
      ok: true,
      output: structuredResult,
      durationMs: 3,
    });
  }
  const structuredCard = page.locator('.tool-card').filter({ hasText: 'structured_result' });
  await structuredCard.locator('summary').click();
  await structuredCard.getByRole('button', { name: 'Inspect call', exact: true }).click();
  const structuredDialog = page.getByRole('dialog');
  const jsonTree = structuredDialog.getByRole('region', {
    name: 'Tool result JSON tree',
    exact: true,
  });
  await jsonTree.getByText('9007199254740993', { exact: true }).waitFor();
  await jsonTree.locator('summary').filter({ hasText: 'files' }).click();
  await jsonTree.locator('summary').filter({ hasText: '0 { 2 fields }' }).click();
  await jsonTree.getByText('"a.ts"', { exact: true }).waitFor();
  await structuredDialog.getByRole('button', { name: 'Copy tool result', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), structuredResult);
  await pinConversation();
  await page.screenshot({
    path: join(output, 'json-tool-tree.png'),
    fullPage: true,
    animations: 'disabled',
  });
  for (const width of [320, 390, 1512]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await structuredDialog.evaluate((element) => element.scrollWidth > element.clientWidth),
      false,
      `JSON tree fits at ${width}px`,
    );
    await structuredDialog.getByRole('button', { name: 'Formatted', exact: true }).click();
    const formatted = await structuredDialog.locator('pre').textContent();
    assert.ok(formatted.includes('\n  "path": "src/app.tsx",'));
    assert.ok(formatted.includes('9007199254740993'));
    assert.ok((await structuredDialog.locator('code .hljs-attr').count()) > 0);
    await structuredDialog.getByRole('button', { name: 'Raw', exact: true }).click();
    assert.equal(await structuredDialog.locator('pre').textContent(), structuredResult);
    await structuredDialog.getByRole('button', { name: 'Tree', exact: true }).click();
  }
  await captureNarrowDialog('json-tool-tree', { pin: true });
  await page.setViewportSize({ width: 1512, height: 982 });
  const markdownResult =
    '# Inspection report\n\n**Ready** to review.\n\n| File | Status |\n| --- | --- |\n| app.tsx | Passed |\n\n```typescript\nconst ready: boolean = true;\n```';
  for (const client of clients)
    frame(client, 'tool.executed', {
      sessionId: 'session-one',
      id: 'structured-proof',
      name: 'structured_result',
      ok: true,
      output: markdownResult,
      durationMs: 4,
    });
  await structuredDialog.getByRole('heading', { name: 'Inspection report', exact: true }).waitFor();
  await structuredDialog.getByRole('table').waitFor();
  assert.ok((await structuredDialog.locator('code .hljs-keyword').count()) > 0);
  await structuredDialog.getByRole('button', { name: 'Copy tool result', exact: true }).click();
  assert.equal(
    (await page.evaluate(() => navigator.clipboard.readText())).replaceAll('\r\n', '\n'),
    markdownResult,
  );
  await pinConversation();
  await page.screenshot({
    path: join(output, 'markdown-tool-result.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await structuredDialog.getByRole('button', { name: 'Source', exact: true }).click();
  assert.equal(
    await structuredDialog.locator('.content-view > .code-panel pre').textContent(),
    markdownResult,
  );
  await structuredDialog.getByRole('button', { name: 'Rendered', exact: true }).click();
  await captureNarrowDialog('markdown-tool-result', { pin: true });
  for (const client of clients)
    frame(client, 'tool.executed', {
      sessionId: 'session-one',
      id: 'structured-proof',
      name: 'structured_result',
      ok: false,
      output: '{"incomplete":',
      durationMs: 5,
    });
  await structuredDialog.locator('pre').filter({ hasText: '{"incomplete":' }).waitFor();
  assert.equal(await structuredDialog.locator('pre').textContent(), '{"incomplete":');
  await structuredDialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  for (const client of clients) {
    frame(client, 'subagent.event', {
      sessionId: 'session-one',
      subagentId: 'idle-worker',
      kind: 'spawned',
      name: 'Idle worker',
      model: 'idle-model',
    });
    frame(client, 'subagent.event', {
      sessionId: 'session-one',
      subagentId: 'worker-review',
      kind: 'spawned',
      name: 'Reviewer',
      provider: 'fixture',
      model: 'worker-model',
      description: 'Inspect the project for regressions',
    });
    frame(client, 'subagent.event', {
      sessionId: 'session-one',
      subagentId: 'worker-review',
      kind: 'task_started',
    });
    frame(client, 'agent.timeline.message', {
      sessionId: 'session-one',
      subagentId: 'worker-review',
      agentName: 'Reviewer',
      kind: 'text',
      content: 'Inspecting the runtime boundary.',
      ts: '2026-10-17T12:00:00Z',
    });
  }
  await page.getByRole('button', { name: 'View agents', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: /Idle worker/ }).count(), 0);
  await page.getByRole('checkbox', { name: /^Show inactive/ }).check();
  await page.getByRole('button', { name: /Idle worker/ }).waitFor();
  await page.getByRole('checkbox', { name: /^Show inactive/ }).uncheck();
  await page.getByRole('button', { name: /Reviewer.*Inspect the project/ }).click();
  // The agent dialog shows the provider-qualified runtime label (agentRuntimeLabel).
  await page.getByRole('dialog').getByText('fixture/worker-model', { exact: true }).waitFor();
  const agentDialogBox = await page.getByRole('dialog').boundingBox();
  assert.ok(
    agentDialogBox && agentDialogBox.width >= 1000,
    'Agent detail gives desktop output a wide reading area',
  );
  await page
    .getByRole('dialog')
    .locator('.agent-latest')
    .getByText('Inspecting the runtime boundary.', { exact: true })
    .waitFor();
  await pinConversation();
  await page.screenshot({
    path: join(output, 'agent-monitor.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await captureNarrowDialog('agent-monitor', { pin: true });
  assert.equal(
    await page
      .getByRole('dialog')
      .locator('.agent-deeper')
      .evaluate((el) => el.hasAttribute('open')),
    false,
    'Verbose activity stays collapsed',
  );
  const longAgentOutput = `Full output begins here. ${'Detailed worker observation. '.repeat(140)} Final worker observation.`;
  for (const client of clients)
    frame(client, 'agent.timeline.message', {
      sessionId: 'session-one',
      subagentId: 'worker-review',
      kind: 'text',
      content: longAgentOutput,
      ts: '2026-10-17T12:01:00Z',
    });
  await page
    .getByRole('dialog')
    .getByText('Latest excerpt. Extended shows the full reported output.', { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole('dialog')
      .locator('.agent-latest .markdown')
      .textContent()
      .then((value) => value?.includes('Full output begins here.') ?? false),
    false,
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Extended', exact: true }).click();
  await page.getByRole('dialog').getByText('worker-review', { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole('dialog')
      .locator('.agent-latest .markdown')
      .textContent()
      .then((value) => value?.includes('Full output begins here.') ?? false),
    true,
  );
  assert.equal(
    await page
      .getByRole('dialog')
      .locator('.agent-deeper')
      .evaluate((element) => element.open),
    true,
  );
  await pinConversation();
  await page.screenshot({
    path: join(output, 'agent-extended.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Simple', exact: true }).click();
  assert.equal(await page.getByRole('dialog').locator('.agent-technical').count(), 0);
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
  // The leader has finished, but its worker still owns live work.
  for (const client of clients)
    frame(client, 'run.result', { sessionId: 'session-one', status: 'done', iterations: 1 });
  const workStatus = page.getByRole('region', { name: 'Session work status', exact: true });
  await workStatus
    .getByText('Leader finished · 1 agent is still working', { exact: true })
    .waitFor();
  assert.equal(await page.locator('.connection-chip').textContent(), 'Working');
  for (const width of [320, 390, 1512]) {
    await page.setViewportSize({ width, height: 844 });
    await workStatus.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `Worker status fits at ${width}px`,
    );
    await page.screenshot({
      path: join(output, `leader-finished-agents-running-${width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
  await workStatus.getByRole('button', { name: 'Watch agents', exact: true }).click();
  await page.getByRole('tabpanel', { name: 'Agents', exact: true }).waitFor();
  const refreshesBeforeWorkerFinished = received.filter(
    (entry) => entry.type === 'git.changes',
  ).length;
  for (const client of clients) {
    frame(client, 'agent.status_changed', {
      sessionId: 'session-one',
      subagentId: 'worker-review',
      status: 'running',
      partialText: 'Stale streaming excerpt.',
    });
    frame(client, 'subagent.event', {
      sessionId: 'session-one',
      subagentId: 'worker-review',
      kind: 'task_completed',
      status: 'done',
      finalText: 'Review completed and saved.',
    });
  }
  await workStatus.getByText('All work finished', { exact: true }).waitFor();
  await expect
    .poll(() => received.filter((entry) => entry.type === 'git.changes').length)
    .toBeGreaterThan(refreshesBeforeWorkerFinished);
  await page.getByText('All agents finished. Showing recent results.', { exact: true }).waitFor();
  assert.equal(await page.locator('.connection-chip').textContent(), 'Ready');
  await page.getByRole('button', { name: /Reviewer.*Inspect the project/ }).click();
  await page
    .getByRole('dialog')
    .locator('.agent-latest')
    .getByText('Review completed and saved.', { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole('dialog')
      .locator('.agent-latest')
      .getByText('Stale streaming excerpt.', { exact: true })
      .count(),
    0,
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.screenshot({
    path: join(output, 'all-work-finished.png'),
    fullPage: true,
    animations: 'disabled',
  });
  // Restart a worker to exercise the chat's session-wide stop control.
  for (const client of clients)
    frame(client, 'subagent.event', {
      sessionId: 'session-one',
      subagentId: 'worker-review',
      kind: 'task_started',
    });
  await workStatus.getByRole('button', { name: 'Stop all agents', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'New session', exact: false }).isDisabled(),
    true,
  );
  const abortsBeforeWorkerStop = received.filter((entry) => entry.type === 'abort').length;
  await workStatus.getByRole('button', { name: 'Stop all agents', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Stop all', exact: true }).click();
  await page.waitForFunction(() =>
    document.body.textContent.includes('Stopped. The leader and its agents are stopped.'),
  );
  assert.equal(
    received.filter((entry) => entry.type === 'abort').length,
    abortsBeforeWorkerStop + 1,
  );
  assert.equal(
    received.filter((entry) => entry.type === 'abort').at(-1).payload.sessionId,
    'session-one',
  );
  // The confirmed stop optimistically ends the whole fleet (the abort carries
  // the worker ids), so the session unlocks without a per-agent acknowledgement.
  await expect(page.getByRole('button', { name: 'New session', exact: false })).toBeEnabled();
  for (const client of clients)
    frame(client, 'agent.status_changed', {
      sessionId: 'session-one',
      subagentId: 'worker-review',
      status: 'stopped',
    });
  await page.getByRole('button', { name: 'Stop all', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(
    await page.getByRole('button', { name: 'New session', exact: false }).isEnabled(),
    true,
  );
  // A stop also preserves pending messages without starting another run.
  // The first stop's aborted acknowledgement is scheduled 100 ms out; wait for
  // it to reach the page before starting the fresh run, so a stale aborted
  // run.result cannot clobber the new run state over fixture timing.
  const abortedAcksBefore = fixtureSent.filter(
    (entry) => entry.type === 'run.result' && entry.payload.status === 'aborted',
  ).length;
  await expect
    .poll(
      () =>
        fixtureSent.filter(
          (entry) => entry.type === 'run.result' && entry.payload.status === 'aborted',
        ).length,
    )
    .toBeGreaterThan(abortedAcksBefore);
  for (const client of clients)
    frame(client, 'session.run_state', { sessionId: 'session-one', isRunning: true });
  await page.getByRole('combobox', { name: 'Message delivery', exact: true }).selectOption('queue');
  await message.fill('Keep this queued after stopping');
  await page.getByRole('button', { name: 'Queue message', exact: true }).click();
  // The queue is still paused from the earlier stop. Resuming and stopping again
  // here would race the dispatch effect in the fixture, so keep it paused: the
  // stop must preserve the pending message without starting another run.
  const messagesBeforeStop = received.filter((entry) => entry.type === 'user_message').length;
  await page.getByRole('button', { name: 'Stop all', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Stop all', exact: true }).click();
  await page.getByRole('button', { name: 'Stop all', exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Resume queue', exact: true }).waitFor();
  assert.equal(
    received.filter((entry) => entry.type === 'user_message').length,
    messagesBeforeStop,
  );
  await page.locator('.message-queue').getByText('Keep this queued after stopping').waitFor();
  await page.getByRole('button', { name: 'Remove queued message 1', exact: true }).click();
  await page.getByRole('tab', { name: 'Activity', exact: true }).click();
  for (const client of clients)
    frame(client, 'tool.executed', {
      sessionId: 'session-one',
      id: 'artifact-tool',
      name: 'present_artifact',
      ok: true,
      durationMs: 2,
      output: JSON.stringify({
        type: 'artifact.presentation',
        version: 2,
        id: 'notes',
        sessionId: 'session-one',
        path: 'notes.md',
        title: 'Project notes',
        kind: 'text',
      }),
    });
  await page.getByRole('button', { name: 'Project notes', exact: true }).click();
  await page.getByText('A concise project report.', { exact: true }).waitFor();
  await page.locator('.header-actions').getByRole('button', { name: 'Files', exact: true }).click();
  const fileHub = page.getByRole('dialog');
  await fileHub.getByRole('button', { name: 'Close selected file', exact: true }).click();
  const fileTypes = fileHub.getByRole('group', { name: 'File types', exact: true });
  await fileHub.getByRole('button', { name: 'notes.md', exact: true }).waitFor();
  await fileTypes.getByRole('button', { name: /^Documents/ }).click();
  await expect(
    fileHub.getByRole('navigation', { name: 'Project file tree' }).getByRole('button'),
  ).toHaveCount(1);
  await fileHub.getByRole('textbox', { name: 'Search project files', exact: true }).fill('app');
  await fileHub.getByText('No files match this search.', { exact: false }).waitFor();
  await fileHub.getByRole('button', { name: 'Clear search and filters', exact: true }).click();
  await fileHub.getByRole('button', { name: 'Show file cards', exact: true }).click();
  await expect(
    fileHub
      .getByRole('button', { name: 'src/app.tsx', exact: true })
      .getByText('app.tsx', { exact: true }),
  ).toBeVisible();
  await expect(
    fileHub.getByRole('navigation', { name: 'Project file tree' }).getByRole('button'),
  ).toHaveCount(3);
  await page.screenshot({
    path: join(output, 'file-manager-discovery.png'),
    animations: 'disabled',
  });
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await fileHub.evaluate((element) => element.scrollWidth > element.clientWidth),
      false,
      `File discovery fits at ${width}px`,
    );
    await page.screenshot({
      path: join(output, `file-manager-discovery-${width}.png`),
      animations: 'disabled',
    });
  }
  await page.setViewportSize({ width: 1512, height: 982 });
  await fileTypes.getByRole('button', { name: /^Images/ }).click();
  await fileHub.getByRole('button', { name: 'assets/cover.png', exact: true }).click();
  await expect(fileHub.locator('.file-preview-image')).toBeVisible();
  await fileHub
    .getByRole('navigation', { name: 'File location' })
    .getByRole('button', { name: 'Project', exact: true })
    .click();
  await page.getByRole('textbox', { name: 'Search project files', exact: true }).fill('app');
  await page.getByRole('button', { name: 'src/app.tsx', exact: true }).click();
  await page.getByRole('dialog').getByText('A concise project report.', { exact: true }).waitFor();
  const fileDownload = page.waitForEvent('download');
  await fileHub.getByRole('button', { name: 'Save a copy', exact: true }).click();
  const savedCopy = await fileDownload;
  assert.equal(savedCopy.suggestedFilename(), 'app.tsx');
  await savedCopy.saveAs(join(output, 'downloaded-app.tsx'));
  assert.equal(
    await readFile(join(output, 'downloaded-app.tsx'), 'utf8'),
    'A concise project report.',
  );
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Copy file contents', exact: true })
    .click();
  await page.getByRole('dialog').getByText('Copied file contents.', { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    'A concise project report.',
  );
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw new Error('Fixture clipboard unavailable');
    };
  });
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Copy file contents', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByText('Could not copy. Select the text to copy it manually.', { exact: true })
    .waitFor();
  await page.evaluate(() => {
    delete navigator.clipboard.writeText;
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Extended', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByText(/1 line · 25 characters/)
    .waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Simple', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Copy file contents', exact: true })
    .click();
  await page.getByRole('dialog').getByText('Copied file contents.', { exact: true }).waitFor();
  const fileContentBox = await page.getByRole('dialog').locator('.file-content').boundingBox();
  const fileDirectoryBox = await page.getByRole('dialog').locator('.files-directory').boundingBox();
  assert.ok(
    fileContentBox.x < fileDirectoryBox.x,
    'File content belongs on the left and directory on the right',
  );
  await page.screenshot({
    path: join(output, 'files-modal.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await captureNarrowDialog('files-modal');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page
      .getByRole('dialog')
      .getByRole('complementary', { name: 'Directories and files', exact: true })
      .isVisible(),
    false,
    'Mobile reading gives the file the full pane',
  );
  await page.getByRole('button', { name: 'Browse files', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search project files', exact: true }).waitFor();
  await page.getByRole('button', { name: 'src/app.tsx', exact: true }).click();
  await page.getByRole('dialog').getByText('A concise project report.', { exact: true }).waitFor();
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.getByRole('button', { name: 'Reference in message', exact: true }).click();
  await page.getByRole('button', { name: 'Remove src/app.tsx', exact: true }).click();
  await message.fill('');
  const chatCountBeforeResources = received.filter((m) => m.type === 'user_message').length;
  await page
    .locator('.workspace-navigation')
    .getByRole('button', { name: 'Library', exact: true })
    .click();
  const hub = page.getByRole('dialog');
  await hub.getByRole('button', { name: /Review a target/ }).click();
  await hub.getByRole('textbox', { name: 'Prompt variable target', exact: true }).waitFor();
  assert.equal(
    await hub.getByRole('button', { name: 'Use prompt in draft', exact: true }).isDisabled(),
    true,
  );
  await hub.getByRole('button', { name: 'Favorite', exact: true }).click();
  await hub.getByRole('button', { name: 'Unfavorite', exact: true }).waitFor();
  await hub.getByRole('button', { name: /^Favorites only/ }).click();
  await expect(
    hub
      .getByRole('navigation', { name: 'Prompts list' })
      .getByRole('button', { name: /Review a target/ }),
  ).toHaveCount(1);
  await hub
    .getByRole('textbox', { name: 'Search resources', exact: true })
    .fill('nothing-matches-this');
  await hub.getByRole('button', { name: 'Show all resources', exact: true }).click();
  await hub.getByRole('button', { name: 'Category: quality', exact: true }).click();
  await expect(
    hub
      .getByRole('navigation', { name: 'Prompts list' })
      .getByRole('button', { name: /FluidFlow/ }),
  ).toHaveCount(0);
  await hub.getByRole('button', { name: 'Reset library filters', exact: true }).click();
  await page.screenshot({ path: join(output, 'library-discovery.png'), animations: 'disabled' });
  await hub
    .getByRole('textbox', { name: 'Prompt variable target', exact: true })
    .fill('src/app.tsx');
  await page.screenshot({
    path: join(output, 'resource-prompts.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await hub.getByRole('button', { name: 'Use prompt in draft', exact: true }).click();
  await expect(message).toHaveValue('Review src/app.tsx');
  for (const width of [1512, 390]) {
    for (const level of ['simple', 'detailed', 'advanced']) {
      await page.setViewportSize({ width: 1512, height: 982 });
      await message.fill('');
      await page
        .locator('.workspace-navigation')
        .getByRole('button', { name: 'Library', exact: true })
        .click();
      await hub.getByRole('button', { name: /Glassmorphism Style/ }).click();
      await hub.getByRole('combobox', { name: 'Prompt detail level' }).waitFor();
      await page.setViewportSize({ width, height: 720 });
      await hub.getByRole('combobox', { name: 'Prompt detail level' }).selectOption(level);
      if (level === 'advanced')
        await page.screenshot({
          path: join(output, `fluidflow-design-${width}.png`),
          fullPage: true,
          animations: 'disabled',
        });
      await hub.getByRole('button', { name: 'Use prompt in draft', exact: true }).click();
      await expect(message).toHaveValue(designPrompt.variants[level]);
    }
  }
  await page.setViewportSize({ width: 1512, height: 982 });
  await message.fill('');
  await page
    .locator('.workspace-navigation')
    .getByRole('button', { name: 'Library', exact: true })
    .click();
  await hub.getByRole('button', { name: 'Save a prompt', exact: true }).click();
  await hub.getByRole('textbox', { name: 'Prompt title', exact: true }).fill('review target');
  await hub
    .getByRole('textbox', { name: 'Saved prompt text', exact: true })
    .fill('Must not overwrite');
  assert.equal(
    await hub.getByRole('button', { name: 'Save to library', exact: true }).isDisabled(),
    true,
    'Existing prompt identifiers must not be overwritten',
  );
  await hub.getByRole('textbox', { name: 'Prompt title', exact: true }).fill('Saved from VibeUI');
  await hub
    .getByRole('textbox', { name: 'Saved prompt text', exact: true })
    .fill('Inspect the current changes and verify behavior.');
  await hub.getByRole('button', { name: 'Save to library', exact: true }).click();
  await hub.getByRole('button', { name: /Saved from VibeUI/ }).waitFor();
  await hub.getByRole('tab', { name: 'Skills', exact: true }).click();
  await hub.getByRole('button', { name: /testing.*Write and verify/ }).click();
  await hub.getByRole('heading', { name: 'Testing instructions', exact: true }).waitFor();
  assert.equal(await hub.getByText('Wrong skill content').count(), 0);
  await hub.getByRole('button', { name: 'Mention this skill', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('textarea[aria-label="Message"]')?.value === '$testing',
  );
  await message.fill('Preserve my unsent idea.');
  await page
    .locator('.workspace-navigation')
    .getByRole('button', { name: 'Tools & MCP', exact: true })
    .click();
  await hub.getByRole('button', { name: /write_file/ }).click();
  await hub.getByRole('button', { name: 'Enable tool', exact: true }).click();
  await hub.getByRole('button', { name: 'Disable tool', exact: true }).waitFor();
  await hub.getByRole('tab', { name: 'MCP', exact: true }).click();
  await hub.getByRole('button', { name: /docs-service/ }).click();
  await hub.getByRole('button', { name: 'Disable connection', exact: true }).click();
  await hub.getByText('Connection is in use.', { exact: true }).waitFor();
  await hub.getByRole('button', { name: 'Disable connection', exact: true }).click();
  await hub.getByRole('button', { name: 'Enable connection', exact: true }).waitFor();
  await page.screenshot({
    path: join(output, 'resource-mcp.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await hub.getByRole('button', { name: 'Enable connection', exact: true }).click();
  await hub.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await hub.getByRole('tab', { name: 'Memory', exact: true }).click();
  const memoryList = hub.getByRole('navigation', { name: 'Memory records', exact: true });
  await memoryList.getByRole('button', { name: /Use Bun for package scripts/ }).waitFor();
  await hub.getByRole('button', { name: 'Preferences', exact: true }).click();
  await expect(memoryList.getByRole('button')).toHaveCount(1);
  await expect(memoryList.getByRole('button', { name: /Keep interfaces focused/ })).toBeVisible();
  await expect(hub.locator('.memory-overview')).toContainText('1 memory found');
  await hub.getByRole('button', { name: 'Decisions', exact: true }).click();
  await hub.getByText('No memories match these filters.', { exact: true }).waitFor();
  await hub.getByRole('button', { name: 'All knowledge', exact: true }).click();
  await expect(memoryList.getByRole('button')).toHaveCount(2);
  await page.screenshot({ path: join(output, 'memory-discovery.png'), animations: 'disabled' });
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await hub.evaluate((element) => element.scrollWidth > element.clientWidth),
      false,
      `Memory discovery fits at ${width}px`,
    );
    await page.screenshot({
      path: join(output, `memory-discovery-${width}.png`),
      animations: 'disabled',
    });
  }
  await page.setViewportSize({ width: 1512, height: 982 });
  assert.equal(await hub.getByLabel('Memory kind', { exact: true }).isVisible(), false);
  await hub.getByRole('button', { name: 'Filters', exact: true }).click();
  await hub.getByLabel('Memory kind', { exact: true }).waitFor();
  await hub.getByRole('button', { name: 'Filters', exact: true }).click();
  await hub.getByRole('button', { name: /Use Bun for package scripts/ }).click();
  await hub
    .locator('.memory-detail')
    .getByText('Use Bun for package scripts.', { exact: true })
    .waitFor();
  await hub.locator('summary').filter({ hasText: 'Sources & details' }).click();
  await hub.getByText('package.json', { exact: false }).waitFor();
  await hub.getByText('90%', { exact: true }).waitFor();
  await hub.getByRole('button', { name: 'Relationships', exact: true }).click();
  assert.equal(
    received.filter((entry) => entry.type === 'memory.sage.graph').at(-1)?.payload.maxDepth,
    1,
    'Relationships must request only direct neighbors',
  );
  await hub.getByText('1 direct relationship', { exact: true }).waitFor();
  assert.equal(
    await hub.locator('.memory-graph').count(),
    0,
    'Relationships start as a readable list',
  );
  assert.equal(
    await hub.locator('.memory-relations button').count(),
    1,
    'Indirect neighbors never appear in the list',
  );
  await hub.getByRole('button', { name: 'Show graph', exact: true }).click();
  await hub.getByRole('region', { name: 'Memory relationship graph', exact: true }).waitFor();
  await hub.locator('.react-flow__edge').waitFor();
  assert.equal(
    await hub.locator('.react-flow__node').count(),
    2,
    'Graph stays focused on the selected memory',
  );
  assert.equal(await hub.locator('.react-flow__edge').count(), 1);
  await page.screenshot({
    path: join(output, 'memory-graph.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await hub.getByRole('button', { name: 'Hide graph', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: join(output, 'memory-relations-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  assert.equal(await hub.evaluate((el) => el.scrollWidth > el.clientWidth), false);
  await hub.getByRole('button', { name: 'All memories', exact: true }).click();
  await hub.getByRole('navigation', { name: 'Memory records', exact: true }).waitFor();
  await hub.getByRole('button', { name: /Use Bun for package scripts/ }).click();
  await hub.getByRole('button', { name: 'Relationships', exact: true }).click();
  await hub.getByText('1 direct relationship', { exact: true }).waitFor();

  await page.setViewportSize({ width: 1512, height: 982 });
  await hub
    .locator('.memory-relations')
    .getByRole('button', { name: /Keep interfaces focused/ })
    .click();
  await hub
    .locator('.memory-detail')
    .getByText('Keep interfaces focused.', { exact: true })
    .waitFor();
  await hub.getByRole('button', { name: 'Relationships', exact: true }).click();
  await hub.getByText('No direct memory relationships recorded.', { exact: true }).waitFor();
  assert.equal(await hub.getByRole('button', { name: 'Show graph', exact: true }).count(), 0);
  await hub.getByRole('textbox', { name: 'Search memory', exact: true }).fill('focused');
  await expect(memoryList.getByRole('button')).toHaveCount(1);
  await memoryList.getByRole('button', { name: /Keep interfaces focused/ }).click();
  await hub.getByRole('button', { name: 'Copy memory', exact: true }).click();
  await hub.getByText('Memory copied.', { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => navigator.clipboard.readText()),
    'Keep interfaces focused.',
  );
  await page.evaluate(() => {
    navigator.clipboard.writeText = async () => {
      throw new Error('Fixture clipboard unavailable');
    };
  });
  await hub.getByRole('button', { name: 'Copy memory', exact: true }).click();
  await hub
    .getByText('Could not copy. Select the memory text to copy it manually.', { exact: true })
    .waitFor();
  await page.evaluate(() => {
    delete navigator.clipboard.writeText;
  });
  await hub.getByRole('button', { name: 'Use in message', exact: true }).click();
  await expect(message).toHaveValue(/Preserve my unsent idea\.[\s\S]*Keep interfaces focused\./);
  await message.fill('');
  assert.equal(
    received.filter((m) => m.type === 'user_message').length,
    chatCountBeforeResources,
    'Resource actions must never submit chat',
  );
  await page.keyboard.press('Control+p');
  await page.getByRole('combobox', { name: 'Search actions', exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole('combobox', { name: 'Search actions', exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  const actionSearch = page.getByRole('combobox', { name: 'Search actions', exact: true });
  await actionSearch.fill('Stop all tasks');
  await page.getByRole('option', { name: /Stop all tasks/ }).waitFor();
  assert.equal(
    await actionSearch.getAttribute('aria-activedescendant'),
    null,
    'Disabled actions do not receive keyboard selection',
  );
  await actionSearch.press('Enter');
  assert.equal(await page.getByRole('dialog').isVisible(), true);
  await actionSearch.fill('Personal instructions');
  await page.getByRole('dialog').locator('mark').first().waitFor();
  await page.screenshot({
    path: join(output, 'quick-actions-refined.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.keyboard.press('Enter');
  await page.getByRole('textbox', { name: 'Personal instructions text', exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('textarea[aria-label="Personal instructions text"]')?.value ===
      'Original shared instructions',
  );
  await page
    .getByRole('textbox', { name: 'Personal instructions text', exact: true })
    .fill('Local draft must survive conflict');
  await page.getByRole('button', { name: 'Save instructions', exact: true }).click();
  await page
    .getByText('Instructions changed on disk. Reload before saving.', { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole('textbox', { name: 'Personal instructions text', exact: true })
      .inputValue(),
    'Local draft must survive conflict',
  );
  await page.getByRole('button', { name: 'Reload saved version', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('textarea[aria-label="Personal instructions text"]')?.value ===
      'Updated outside this editor',
  );
  await page
    .getByRole('textbox', { name: 'Personal instructions text', exact: true })
    .fill('Verified shared instructions');
  await page.getByRole('button', { name: 'Save instructions', exact: true }).click();
  await page.getByText('Instructions saved.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.keyboard.press('Control+Shift+f');
  await page
    .getByRole('combobox', { name: 'Search conversation text', exact: true })
    .fill('Change direction now');
  await page.getByRole('dialog').locator('mark').first().waitFor();
  await page.screenshot({
    path: join(output, 'conversation-search-refined.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page
    .getByRole('combobox', { name: 'Search conversation text', exact: true })
    .press('ArrowDown');
  await page
    .getByRole('combobox', { name: 'Search conversation text', exact: true })
    .press('Enter');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settingsWrites = received.filter((entry) => entry.type === 'prefs.update').length;
  const settingsSearch = page.getByRole('textbox', { name: 'Search settings', exact: true });
  await settingsSearch.fill('not-an-existing-setting');
  await page.getByText('0 matching settings', { exact: true }).waitFor();
  await settingsSearch.fill('subagents');
  await page
    .getByRole('region', { name: 'Matching settings' })
    .getByRole('button', { name: /Allow subagents/ })
    .waitFor();
  await page.screenshot({
    path: join(output, 'settings-search.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page
    .getByRole('region', { name: 'Matching settings' })
    .getByRole('button', { name: /Allow subagents/ })
    .click();
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="Allow subagents"]') === document.activeElement,
  );
  assert.equal(
    received.filter((entry) => entry.type === 'prefs.update').length,
    settingsWrites,
    'Searching and navigating never changes a preference',
  );
  await settingsSearch.fill('reasoning');
  await settingsSearch.press('Escape');
  assert.equal(await settingsSearch.inputValue(), '');
  assert.equal(
    await page.getByRole('dialog').isVisible(),
    true,
    'Escape clears search before closing settings',
  );
  await page
    .getByRole('dialog')
    .locator('summary')
    .filter({ hasText: /^Execution & delegation$/ })
    .click();

  await page
    .getByRole('dialog')
    .locator('summary')
    .filter({ hasText: /^Context & efficiency$/ })
    .click();
  await page.getByRole('combobox', { name: 'Context policy', exact: true }).selectOption('frugal');
  await page.waitForFunction(
    () => document.querySelector('select[aria-label="Context policy"]')?.value === 'frugal',
  );
  await page
    .getByRole('dialog')
    .locator('summary')
    .filter({ hasText: /^Execution & delegation$/ })
    .click();
  await page.getByRole('spinbutton', { name: 'Iteration limit', exact: true }).fill('40');
  await page.getByRole('button', { name: 'Apply iteration limit', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('input[aria-label="Iteration limit"]')?.value === '40',
  );
  assert.ok(
    received.some(
      (m) =>
        m.type === 'prefs.update' &&
        m.payload.sessionId === 'session-one' &&
        m.payload.maxIterations === 40,
    ),
  );
  await page
    .getByRole('dialog')
    .locator('summary')
    .filter({ hasText: /^Refiner & reasoning$/ })
    .click();
  await page
    .getByRole('combobox', { name: 'Refiner model', exact: true })
    .selectOption('fixture\tfixture-model');
  await page.waitForFunction(
    () =>
      document.querySelector('select[aria-label="Refiner model"]')?.value ===
      'fixture\tfixture-model',
  );
  await page.screenshot({
    path: join(output, 'advanced-settings.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.screenshot({
    path: `${output}/desktop-conversation.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await message.fill('Draft kept through reload');
  await page.reload();
  await page.getByRole('textbox', { name: 'Message', exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('textarea[aria-label="Message"]')?.value ===
      'Draft kept through reload',
  );
  // An ordinary remote close must reconnect and hydrate the canonical transcript.
  // An approval the server resolved while the page was away must not survive it.
  for (const client of clients)
    frame(client, 'tool.confirm_needed', {
      sessionId: 'session-one',
      id: 'stale-permission',
      toolName: 'write_file',
      input: { path: 'src/stale.ts' },
    });
  await page.getByRole('heading', { name: 'Your permission is needed' }).waitFor();
  const before = connections;
  for (const client of clients) client.close(1000, 'fixture restart');
  await page.getByText('Restored answer', { exact: true }).waitFor({ timeout: 15000 });
  assert.ok(connections > before);
  await page
    .getByRole('heading', { name: 'Your permission is needed' })
    .waitFor({ state: 'hidden', timeout: 5000 });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Light', exact: true }).click();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.screenshot({
    path: `${output}/desktop-light.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  // Crossing below 1100px with no dialog open closes the workspace panel.
  await page.waitForFunction(() => document.querySelector('.workspace-panel') === null, undefined, {
    timeout: 5000,
  });
  await page.getByRole('button', { name: 'Open sessions', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector('.session-sidebar')?.getBoundingClientRect().left >= 0,
  );
  await page.screenshot({
    path: join(output, 'mobile-navigation.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Second session', exact: false }).click();
  await page.getByText('Restored answer', { exact: true }).waitFor();
  await page.waitForFunction(() =>
    document.querySelector('.session-row.active')?.textContent?.includes('Second session'),
  );
  await page.reload();
  await page.waitForFunction(() =>
    document.querySelector('.session-row.active')?.textContent?.includes('Second session'),
  );
  await page.getByText('Restored answer', { exact: true }).waitFor();
  await page.screenshot({
    path: `${output}/mobile-light.png`,
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Open sessions', exact: true }).click();
  await page
    .locator('.workspace-navigation')
    .getByRole('button', { name: 'Library', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Review a target/ })
    .click();
  assert.equal(
    await page
      .getByRole('dialog')
      .getByRole('navigation', { name: 'Prompts list', exact: true })
      .isVisible(),
    false,
  );
  await page.getByRole('dialog').getByRole('button', { name: 'All prompts', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('navigation', { name: 'Prompts list', exact: true })
    .waitFor();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /Review a target/ })
    .click();
  await page.getByRole('textbox', { name: 'Prompt variable target', exact: true }).waitFor();
  await page
    .getByRole('textbox', { name: 'Prompt variable target', exact: true })
    .fill('mobile.ts');
  await page
    .getByRole('button', { name: 'Use prompt in draft', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(output, 'mobile-resources.png'),
    fullPage: true,
    animations: 'disabled',
  });
  // The close action stays reachable after scrolling a long modal on narrow screens.
  for (const width of [320, 390, 768, 1512]) {
    await page.setViewportSize({ width, height: 720 });
    await page
      .getByRole('button', { name: 'Use prompt in draft', exact: true })
      .scrollIntoViewIfNeeded();
    const bounds = await page.getByRole('dialog').evaluate((dialog) => {
      const rect = dialog.getBoundingClientRect();
      const close = dialog
        .querySelector('button[aria-label="Close dialog"]')
        ?.getBoundingClientRect();
      return {
        fits:
          rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
        closeVisible: Boolean(close && close.top >= rect.top && close.bottom <= rect.bottom),
        horizontalOverflow: dialog.scrollWidth > dialog.clientWidth,
      };
    });
    assert.equal(bounds.fits, true, `Dialog fits at ${width}px`);
    assert.equal(bounds.closeVisible, true, `Close stays visible after scrolling at ${width}px`);
    assert.equal(
      bounds.horizontalOverflow,
      false,
      `Dialog has no horizontal overflow at ${width}px`,
    );
    if (width === 320 || width === 768) {
      await page.screenshot({
        path: join(output, `resources-${width}.png`),
        fullPage: true,
        animations: 'disabled',
      });
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
    false,
    'Resources must fit on mobile',
  );
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Use prompt in draft', exact: true })
    .click();
  await page.setViewportSize({ width: 1512, height: 982 });
  // Real authored input stays separate from replayed host guidance.
  const runtimeContext = page.locator('.runtime-context').first();
  assert.equal(await runtimeContext.locator('pre').first().isVisible(), false);
  await runtimeContext.locator('summary').click();
  await runtimeContext.getByText(/Runtime coaching/).waitFor();
  await page.screenshot({
    path: join(output, 'runtime-context-expanded.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await runtimeContext.locator('summary').click();

  await message.fill('$');
  await page.getByText('42 matching · 42 installed', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('listbox', { name: 'Skills', exact: true }).getByRole('option').count(),
    42,
  );
  await message.press('PageDown');
  await message.press('PageDown');
  assert.equal(
    await page
      .getByRole('listbox', { name: 'Skills', exact: true })
      .evaluate((element) => element.scrollTop > 0),
    true,
  );
  await page.screenshot({
    path: join(output, 'skills-browser.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await message.press('Escape');
  await message.fill('');

  await page.getByRole('button', { name: 'Provider usage and quotas', exact: true }).click();
  await page.getByText('75% remaining', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Extended', exact: true }).click();
  const quotaTree = page
    .getByRole('dialog')
    .getByRole('region', { name: 'Quota details JSON tree', exact: true });
  await quotaTree.locator('summary').filter({ hasText: 'windows' }).click();
  await quotaTree.locator('summary').filter({ hasText: /^0 / }).click();
  await quotaTree.getByText('usedPercent', { exact: true }).waitFor();
  await page.screenshot({
    path: join(output, 'provider-quotas.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Simple', exact: true }).click();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();

  // Markdown file links open in-app, including malformed duplicated local URLs.
  for (const client of clients) {
    frame(client, 'provider.response', {
      sessionId: 'session-two',
      content: [
        {
          type: 'text',
          text: `[Generated report](${origin}/.temp_files/kanban-handoff/.temp_files/kanban-handoff/REPORT.md)`,
        },
      ],
      stopReason: 'end_turn',
    });
    frame(client, 'run.result', { sessionId: 'session-two', status: 'done', iterations: 1 });
  }
  await page.getByRole('link', { name: 'Generated report', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('heading', { name: 'Generated report', exact: true })
    .waitFor();
  assert.ok(
    received.some(
      (entry) =>
        entry.type === 'files.read' &&
        entry.payload.filePath === '.temp_files/kanban-handoff/REPORT.md',
    ),
  );
  await page.getByRole('link', { name: 'Open HTML preview', exact: true }).click();
  await page
    .frameLocator('iframe.html-preview')
    .getByRole('heading', { name: 'Generated HTML preview', exact: true })
    .waitFor();
  assert.equal(await page.locator('iframe.html-preview').getAttribute('sandbox'), '');
  await page.screenshot({
    path: join(output, 'html-artifact.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Extended', exact: true }).click();
  await page
    .getByRole('dialog')
    .locator('.source-preview')
    .filter({ hasText: '<!doctype html>' })
    .waitFor();
  await page.getByRole('button', { name: 'Simple', exact: true }).click();
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  assert.equal(new URL(page.url()).pathname, '/');

  // BTW is an acknowledged session-scoped note and never aborts the run.
  for (const client of clients)
    frame(client, 'provider.text_delta', { sessionId: 'session-two', text: 'Working on the task' });
  const beforeBtw = received.length;
  await page.getByRole('combobox', { name: 'Message delivery', exact: true }).selectOption('btw');
  assert.equal(
    await page.getByRole('button', { name: 'New session', exact: false }).isDisabled(),
    true,
  );
  assert.equal(await page.locator('.session-row:enabled').count(), 0);
  await message.fill('reject-btw');
  await page.getByRole('button', { name: 'Send BTW note', exact: true }).click();
  await page.getByText('BTW rejected by fixture', { exact: true }).waitFor();
  assert.equal(await message.inputValue(), 'reject-btw');
  await message.fill('Also keep the footer quiet');
  await page.getByRole('button', { name: 'Send BTW note', exact: true }).click();
  await page.getByText('Also keep the footer quiet', { exact: true }).waitFor();
  assert.equal(
    received
      .slice(beforeBtw)
      .filter(
        (entry) =>
          entry.type === 'abort' ||
          entry.type === 'user_message' ||
          entry.type === 'session.new' ||
          entry.type === 'session.resume',
      ).length,
    0,
  );
  assert.ok(
    received
      .slice(beforeBtw)
      .some(
        (entry) =>
          entry.type === 'mailbox.send' &&
          entry.payload.sessionId === 'session-two' &&
          entry.payload.to === 'leader' &&
          entry.payload.type === 'btw',
      ),
  );
  for (const client of clients) {
    frame(client, 'provider.response', {
      sessionId: 'session-two',
      content: [{ type: 'text', text: 'Working on the task, with the footer kept quiet.' }],
      stopReason: 'end_turn',
    });
    frame(client, 'run.result', { sessionId: 'session-two', status: 'done', iterations: 1 });
  }
  await page
    .getByText('Working on the task, with the footer kept quiet.', { exact: true })
    .waitFor();

  // Batch actions submit once without consuming or replacing the user's draft.
  for (const client of clients)
    frame(client, 'provider.response', {
      sessionId: 'session-two',
      content: [
        {
          type: 'text',
          text: 'Choose follow-ups.\n<nextsteps>\n1. First batch task\n2. Second batch task\n</nextsteps>',
        },
      ],
      stopReason: 'end_turn',
    });
  await message.fill('Keep my unsent draft');
  await page
    .getByRole('checkbox', { name: 'Select step 1: First batch task', exact: true })
    .check();
  await page
    .getByRole('checkbox', { name: 'Select step 2: Second batch task', exact: true })
    .check();
  await pinConversation();
  await page.screenshot({
    path: join(output, 'next-steps-selection.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Submit selected', exact: true }).click();
  await page
    .locator('.message-user')
    .last()
    .getByText('First batch task', { exact: true })
    .waitFor();
  assert.equal(
    received.filter((entry) => entry.type === 'user_message').at(-1).payload.content,
    '1. First batch task\n2. Second batch task',
  );
  assert.equal(await message.inputValue(), 'Keep my unsent draft');
  await page.waitForFunction(() => !document.querySelector('.working-line'));
  await message.fill('');

  await page.clock.install();
  for (const client of clients)
    frame(client, 'prefs.updated', {
      sessionId: 'session-two',
      yolo: true,
      autonomy: 'auto',
      autonomyDelayMs: 1000,
      autoProceedMaxIterations: 0,
    });
  await message.fill('Auto ownership seed');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel auto-submit', exact: true }).waitFor();
  await page.clock.fastForward(1100);
  await page.getByText('Auto follow-up proof', { exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('.working-line'));
  assert.equal(
    received.filter(
      (entry) => entry.type === 'user_message' && entry.payload.content === 'Auto follow-up proof',
    ).length,
    1,
  );
  await message.fill('Auto cancellation seed');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel auto-submit', exact: true }).click();
  await page.clock.fastForward(2000);
  assert.equal(
    received.filter(
      (entry) =>
        entry.type === 'user_message' && entry.payload.content === 'Cancelled follow-up proof',
    ).length,
    0,
  );
  const beforeForeignCompletion = received.filter((entry) => entry.type === 'user_message').length;
  for (const client of clients) {
    frame(client, 'provider.response', {
      sessionId: 'session-two',
      content: [
        {
          type: 'text',
          text: 'A different browser finished.\n<nextsteps>\n1. Never submit from this observer auto="true"\n</nextsteps>',
        },
      ],
      stopReason: 'end_turn',
    });
    frame(client, 'run.result', {
      sessionId: 'session-two',
      requestId: 'owned-by-another-client',
      status: 'done',
      iterations: 1,
    });
  }
  await page.getByText('A different browser finished.', { exact: true }).waitFor();
  await page.clock.fastForward(2000);
  assert.equal(
    await page.getByRole('button', { name: 'Cancel auto-submit', exact: true }).count(),
    0,
  );
  assert.equal(
    received.filter((entry) => entry.type === 'user_message').length,
    beforeForeignCompletion,
    'Observers never auto-submit another client’s completed run',
  );
  for (const client of clients)
    frame(client, 'prefs.updated', { sessionId: 'session-two', autonomy: 'suggest' });

  // Clear is explicit and does not touch another session's saved journal.
  await message.fill('Draft to clear');
  await page.getByRole('button', { name: 'Session actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Clear current context', exact: true }).click();
  await page.getByRole('button', { name: 'Keep conversation', exact: true }).click();
  assert.equal(await message.inputValue(), 'Draft to clear');
  await page.getByRole('button', { name: 'Session actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Clear current context', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Clear current context', exact: true })
    .click();
  await page.waitForFunction(
    () =>
      document.querySelector('textarea[aria-label="Message"]')?.value === '' &&
      !document.querySelector('.transcript'),
  );
  assert.ok(
    received.some(
      (entry) => entry.type === 'context.clear' && entry.payload.sessionId === 'session-two',
    ),
  );
  await page.getByRole('button', { name: 'New session', exact: false }).click();
  await page.waitForFunction(() =>
    JSON.parse(localStorage.getItem('wrongstack.vibeui.active-session.v1')).id.startsWith(
      'new-session-',
    ),
  );
  await page.getByRole('button', { name: /Focused workspace/ }).click();
  await page.waitForFunction(
    () =>
      JSON.parse(localStorage.getItem('wrongstack.vibeui.active-session.v1')).id === 'session-one',
  );

  // Fault scenarios run in their own page with their own fake clock. Playwright
  // cannot uninstall a clock, and the 31 s jumps below fire every due timer in
  // the page; isolating them keeps those jumps away from the main page's timers
  // (reconnect backoff, notices, copy feedback) for the rest of the run.
  {
    const faultPage = await browser.newPage({ viewport: { width: 1512, height: 982 } });
    await useStudioFixture(faultPage);
    faultPage.setDefaultTimeout(10_000);
    faultPage.on('pageerror', (error) => errors.push(error.message));
    faultPage.on('console', (entry) => {
      if (entry.type() === 'error') errors.push(entry.text());
    });
    try {
      await faultPage.goto(origin);
      await faultPage.getByText('Ready', { exact: true }).waitFor();
      // Install after load, as the main page does: a clock installed before
      // navigation also fakes the startup timers the app relies on.
      await faultPage.clock.install();
      // A refused or unanswered session open must release the lock, the awaited
      // session and its deadline together, so the user can keep switching.
      const activeSession = () =>
        faultPage.evaluate(
          () => JSON.parse(localStorage.getItem('wrongstack.vibeui.active-session.v1')).id,
        );
      const newSessionButton = faultPage.getByRole('button', { name: 'New session', exact: false });
      const waitUnlocked = async (why) => {
        await faultPage.waitForFunction(
          () => !document.body.textContent?.includes('Switching session:'),
          undefined,
          { timeout: 5000 },
        );
        await newSessionButton.waitFor();
        assert.equal(await newSessionButton.isEnabled(), true, `${why}: New session is enabled`);
        assert.ok(
          (await faultPage.locator('.session-row:enabled').count()) > 0,
          `${why}: rows enabled`,
        );
      };

      // 1. The server refuses a resume with an error.
      failNextResume = true;
      await faultPage.getByRole('button', { name: 'Second session', exact: false }).click();
      await faultPage
        .getByText('Fixture could not resume that session', { exact: true })
        .first()
        .waitFor();
      await waitUnlocked('Refused resume');
      assert.equal(
        await activeSession(),
        'session-one',
        'A refused resume keeps the current session',
      );
      assert.equal(failNextResume, false, 'The fixture refused exactly one resume');
      // The abandoned 30 s deadline must not fire later and disturb the UI.
      await faultPage.clock.fastForward(31_000);
      await waitUnlocked('After the refused resume deadline');
      assert.equal(
        await faultPage.getByText('Session did not open', { exact: false }).count(),
        0,
        'The abandoned switch deadline never fires',
      );
      // Switching still works and is not filtered by a stale awaited session.
      await faultPage.getByRole('button', { name: 'Second session', exact: false }).click();
      await faultPage.waitForFunction(
        () =>
          JSON.parse(localStorage.getItem('wrongstack.vibeui.active-session.v1')).id ===
          'session-two',
      );
      await waitUnlocked('Switch after a refused resume');

      // 2. The server never answers a clear, then reports an error for it.
      silenceNextClear = true;
      await faultPage.getByRole('button', { name: 'Session actions', exact: true }).click();
      await faultPage.getByRole('menuitem', { name: 'Clear current context', exact: true }).click();
      await faultPage
        .getByRole('dialog')
        .getByRole('button', { name: 'Clear current context', exact: true })
        .click();
      await faultPage.getByText('Switching session:', { exact: false }).first().waitFor();
      assert.equal(await newSessionButton.isDisabled(), true, 'Input is locked while clearing');
      assert.equal(silenceNextClear, false, 'The fixture ignored exactly one clear');
      for (const client of clients)
        frame(client, 'error', { sessionId: 'session-two', message: 'Fixture clear failed' });
      await faultPage.getByText('Fixture clear failed', { exact: true }).first().waitFor();
      await waitUnlocked('Clear ended by an error');
      // Before the fix the clear deadline survived the error and re-locked the UI.
      await faultPage.clock.fastForward(31_000);
      await waitUnlocked('After the abandoned clear deadline');
      assert.equal(
        await faultPage.getByText('Clear was not confirmed', { exact: false }).count(),
        0,
        'The abandoned clear deadline never fires',
      );
      await faultPage.getByRole('button', { name: /Focused workspace/ }).click();
      await faultPage.waitForFunction(
        () =>
          JSON.parse(localStorage.getItem('wrongstack.vibeui.active-session.v1')).id ===
          'session-one',
      );
      await waitUnlocked('Switch after an abandoned clear');
      await newSessionButton.click();
      await faultPage.waitForFunction(() =>
        JSON.parse(localStorage.getItem('wrongstack.vibeui.active-session.v1')).id.startsWith(
          'new-session-',
        ),
      );
      await waitUnlocked('New session after the fault scenarios');
      await faultPage.getByRole('button', { name: /Focused workspace/ }).click();
      await faultPage.waitForFunction(
        () =>
          JSON.parse(localStorage.getItem('wrongstack.vibeui.active-session.v1')).id ===
          'session-one',
      );
    } finally {
      await faultPage.close();
    }
  }

  // Escape while typing belongs to the composer, not to the layout.
  const workspacePanel = page.locator('aside.workspace-panel');
  const panelWasOpen = await workspacePanel.isVisible();
  if (!panelWasOpen)
    await page.getByRole('button', { name: 'Toggle workspace', exact: true }).click();
  await workspacePanel.waitFor();
  await message.fill('Draft with @src');
  await message.press('Escape');
  // Let React commit any panel change before asserting (two animation frames).
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  assert.equal(await workspacePanel.isVisible(), true, 'Escape in the composer keeps the panel');
  await message.fill('');
  // Outside text fields Escape still collapses the panel.
  await page.evaluate(() => document.activeElement?.blur());
  await page.keyboard.press('Escape');
  await workspacePanel.waitFor({ state: 'hidden' });
  if (panelWasOpen) {
    await page.getByRole('button', { name: 'Toggle workspace', exact: true }).click();
    await workspacePanel.waitFor();
  }

  // A live, compact list rotates the last three calls without exposing payloads.
  if (!(await workspacePanel.isVisible()))
    await page.getByRole('button', { name: 'Toggle workspace', exact: true }).click();
  await page.getByRole('tab', { name: /Changes/ }).click();
  for (const client of clients) {
    frame(client, 'provider.text_delta', {
      sessionId: 'session-one',
      messageId: 'recent-activity-proof',
      text: 'Inspecting workspace activity.',
    });
    for (const [index, name] of [
      'read_file',
      'search_files',
      'run_tests',
      'apply_patch',
    ].entries()) {
      frame(client, 'tool.started', {
        sessionId: 'session-one',
        id: `recent-proof-${index}`,
        name,
        input: { secret: 'hidden activity argument' },
      });
      if (index < 3)
        frame(client, 'tool.executed', {
          sessionId: 'session-one',
          id: `recent-proof-${index}`,
          name,
          ok: index !== 2,
          output: index === 2 ? 'Test process exited with code 1.' : 'hidden activity result',
          durationMs: 4,
        });
    }
  }
  const recentTools = page.getByRole('list', { name: 'Recent tool calls', exact: true });
  await recentTools
    .getByRole('button', { name: 'Inspect apply_patch · Running', exact: true })
    .waitFor();
  assert.deepEqual(await recentTools.locator('.recent-tool-name').allTextContents(), [
    'apply_patch',
    'run_tests',
    'search_files',
  ]);
  assert.equal((await recentTools.textContent()).includes('hidden activity'), false);
  await page.getByRole('button', { name: 'View activity', exact: true }).click();
  await page.getByRole('tabpanel', { name: 'Activity', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('tab', { name: 'Activity', exact: true }).getAttribute('data-state'),
    'active',
  );
  for (const client of clients)
    frame(client, 'tool.executed', {
      sessionId: 'session-one',
      id: 'recent-proof-1',
      name: 'search_files',
      ok: true,
      output: 'hidden activity result',
      durationMs: 5,
    });
  await page.waitForFunction(
    () => document.querySelector('.recent-tool-name')?.textContent === 'search_files',
  );
  assert.deepEqual(await recentTools.locator('.recent-tool-name').allTextContents(), [
    'search_files',
    'apply_patch',
    'run_tests',
  ]);
  await page
    .getByRole('navigation', { name: 'Workspace shortcuts', exact: true })
    .getByRole('button', { name: /^Agents/ })
    .click();
  await page.getByRole('tabpanel', { name: 'Agents', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
  await page.getByRole('button', { name: 'View activity', exact: true }).click();
  await page.getByRole('tabpanel', { name: 'Activity', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Close workspace', exact: true }).click();
  for (const width of [320, 390, 1512]) {
    await page.setViewportSize({ width, height: 844 });
    await recentTools.scrollIntoViewIfNeeded();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `Recent tools fit at ${width}px`,
    );
    assert.equal(await recentTools.locator('li').count(), 3);
    assert.equal(
      await recentTools.evaluate((element) => element.getBoundingClientRect().height <= 100),
      true,
      'Three calls stay compact',
    );
    await page.screenshot({
      path: join(output, `recent-tools-${width}.png`),
      fullPage: true,
      animations: 'disabled',
    });
  }
  await recentTools
    .getByRole('button', { name: 'Inspect run_tests · Failed', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByText('Test process exited with code 1.', { exact: true })
    .waitFor();
  for (const client of clients)
    frame(client, 'run.result', { sessionId: 'session-one', status: 'done', iterations: 1 });
  await page.locator('.working-activity').waitFor({ state: 'hidden' });
  assert.equal(
    await page.getByRole('dialog').isVisible(),
    true,
    'Inspect stays open when the run finishes',
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.setViewportSize({ width: 1512, height: 982 });
  if (panelWasOpen)
    await page.getByRole('button', { name: 'Toggle workspace', exact: true }).click();

  // Large code, tables and rapid clipboard operations stay contained and accessible.
  const largeCode = `const ready = true;\nconst longLine = "${'x'.repeat(1600)}";\n${Array.from({ length: 5000 }, (_, i) => `// line ${i + 1}: checked payload`).join('\n')}\n`;
  const wideTable =
    '| Alpha | Beta | Gamma | Delta | Epsilon | Zeta |\n| --- | --- | --- | --- | --- | --- |\n' +
    Array.from(
      { length: 12 },
      (_, i) =>
        `| ${Array.from({ length: 6 }, (_, col) => `Value ${i + 1}.${col + 1}`).join(' | ')} |`,
    ).join('\n');
  for (const client of clients)
    frame(client, 'provider.response', {
      sessionId: 'session-one',
      content: [
        {
          type: 'text',
          text: `Code and table stress proof.\n\n\`\`\`javascript\n${largeCode}\`\`\`\n\n${wideTable}`,
        },
      ],
      stopReason: 'end_turn',
    });
  const codePanel = page.locator('.message-assistant').last().locator('.code-panel');
  await codePanel.getByRole('button', { name: 'Copy code', exact: true }).waitFor();
  await codePanel.getByRole('button', { name: 'Wrap lines', exact: true }).click();
  await codePanel.evaluate((element) => {
    window.__originalCodePanel = element;
  });
  await page.getByRole('button', { name: 'Toggle workspace', exact: true }).click();
  assert.equal(
    await codePanel.getAttribute('data-wrap'),
    'true',
    'Workspace updates preserve reader settings',
  );
  assert.equal(
    await page.evaluate(() => window.__originalCodePanel.isConnected),
    true,
    'Workspace updates preserve the code panel DOM',
  );
  await page.getByRole('button', { name: 'Toggle workspace', exact: true }).click();
  await codePanel.getByRole('button', { name: 'Wrap lines', exact: true }).click();
  assert.ok(
    await codePanel
      .locator('pre')
      .evaluate((element) => element.scrollHeight > element.clientHeight),
  );
  await codePanel.getByRole('button', { name: 'Copy code', exact: true }).click();
  await codePanel.getByText('Copied', { exact: true }).waitFor();
  const copiedCode = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(
    copiedCode.replaceAll('\r\n', '\n') === largeCode,
    'Clipboard preserves all code text with native line endings',
  );
  await page.evaluate(() => {
    let calls = 0;
    navigator.clipboard.writeText = () =>
      ++calls === 1
        ? new Promise((resolve) => {
            window.__resolveFirstCopy = resolve;
          })
        : Promise.reject(new Error('Fixture copy failure'));
  });
  await codePanel.getByRole('button', { name: 'Copy code', exact: true }).click();
  await codePanel.getByRole('button', { name: 'Copy code', exact: true }).click();
  await codePanel
    .getByText('Copy unavailable. You can select and copy the text manually.', { exact: true })
    .waitFor();
  await page.evaluate(() => {
    window.__resolveFirstCopy();
    delete navigator.clipboard.writeText;
  });
  assert.equal(
    await codePanel.getByText('Copied', { exact: true }).count(),
    0,
    'Late clipboard completion never replaces the newer failure state',
  );
  await codePanel.getByRole('button', { name: 'Copy code', exact: true }).click();
  await codePanel.getByText('Copied', { exact: true }).waitFor();
  for (const width of [320, 390, 1512]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `Large output fits at ${width}px`,
    );
    assert.ok(
      await codePanel
        .locator('pre')
        .evaluate((element) => element.scrollWidth > element.clientWidth),
      'Long lines scroll inside the code panel',
    );
    await codePanel.getByRole('button', { name: 'Wrap lines', exact: true }).click();
    assert.equal(
      await codePanel.locator('pre').evaluate((element) => getComputedStyle(element).whiteSpace),
      'pre-wrap',
    );
    assert.ok(
      await codePanel
        .locator('pre')
        .evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      'Wrapped text stays inside the reader',
    );
    await codePanel.getByRole('button', { name: 'Wrap lines', exact: true }).click();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const table = page.getByRole('region', { name: 'Scrollable table', exact: true });
  assert.ok(await table.evaluate((element) => element.scrollWidth > element.clientWidth));
  await table.focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('.markdown-table').scrollLeft > 0);
  await codePanel.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: join(output, 'mobile-code-panel.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 1512, height: 982 });

  // Consecutive workspace entries share one disclosure; search opens hidden notes.
  for (const client of clients) {
    for (const text of [
      'Workspace grouping first note',
      'Workspace grouping second note',
      'Workspace grouping final note',
    ]) {
      // Only errors in a run phase become transcript notes; request errors are notices.
      frame(client, 'error', { sessionId: 'session-one', message: text, phase: 'provider' });
    }
  }
  const notes = page.locator('.workspace-notes').last();
  await notes.locator('summary').getByText('3 notes', { exact: true }).waitFor();
  assert.equal(
    await notes.getByText('Workspace grouping first note', { exact: true }).isVisible(),
    false,
  );
  await notes.locator('summary').click();
  assert.equal(await notes.locator('article').count(), 3);
  await notes.getByText('Workspace grouping second note', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({
    path: join(output, 'workspace-notes-mobile.png'),
    animations: 'disabled',
  });
  await page.locator('main.conversation').evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event('scroll'));
  });
  const latest = page.getByRole('button', { name: 'Latest', exact: true });
  await expect(latest).toBeVisible();
  const latestBounds = await latest.boundingBox();
  const readingBounds = await page.locator('main.conversation').boundingBox();
  assert.ok(
    latestBounds.y >= readingBounds.y &&
      latestBounds.y + latestBounds.height <= readingBounds.y + readingBounds.height,
    'Latest must stay inside the conversation above the controls',
  );
  await notes.locator('summary').click();
  await page.setViewportSize({ width: 1512, height: 982 });
  await page.keyboard.press('Control+Shift+f');
  await page
    .getByRole('combobox', { name: 'Search conversation text', exact: true })
    .fill('Workspace grouping first note');
  await page
    .getByRole('dialog')
    .getByRole('option', { name: /Workspace.*Workspace grouping first note/ })
    .click();
  await notes.getByText('Workspace grouping first note', { exact: true }).waitFor();
  assert.equal(await notes.evaluate((element) => element.open), true);
  await page.setViewportSize({ width: 1512, height: 982 });
  await pinConversation();
  await page.screenshot({
    path: join(output, 'workspace-notes-desktop.png'),
    animations: 'disabled',
  });
  await notes.locator('summary').click();
  await page.setViewportSize({ width: 390, height: 844 });

  // Keyboard and queue checks exercise the production components without paid model calls.
  {
    const interaction = await browser.newPage({ viewport: { width: 320, height: 568 } });
    interaction.on('pageerror', (error) => errors.push(error.message));
    try {
      await interaction.goto(origin);
      await expect(interaction.locator('.connection-chip')).toHaveText('Ready');
      const draft = interaction.getByRole('textbox', { name: 'Message', exact: true });
      await draft.fill('Keep this draft');
      await draft.press('Control+Shift+f');
      await expect(interaction.getByRole('dialog')).toBeVisible();
      await interaction.keyboard.press('Escape');
      await expect(draft).toBeFocused();
      await draft.fill('@app');
      const files = interaction.getByRole('region', { name: 'Matching project files' });
      await expect(files.getByRole('option')).toHaveCount(2);
      await draft.press('ArrowDown');
      await expect(
        files.getByRole('option', { name: 'src/styles.css', exact: true }),
      ).toHaveAttribute('aria-selected', 'true');
      await draft.press('Enter');
      await expect(
        interaction.getByRole('button', { name: 'Remove src/styles.css', exact: true }),
      ).toBeVisible();
      await expect(draft).toHaveValue('');
      await expect(draft).toBeFocused();
      await interaction.getByRole('button', { name: 'Remove src/styles.css', exact: true }).click();
      await draft.fill('Keep @app');
      await expect(files).toBeVisible();
      await draft.press('Escape');
      await expect(files).toHaveCount(0);
      await expect(draft).toHaveValue('Keep @app');
      await draft.fill('Hold for queue layout');
      await interaction.getByRole('button', { name: 'Send message', exact: true }).click();
      await expect(
        interaction.getByRole('button', { name: 'Queue message', exact: true }),
      ).toBeVisible();
      for (let i = 0; i < 9; i++) {
        await draft.fill('Queued layout message ' + i);
        await interaction.getByRole('button', { name: 'Queue message', exact: true }).click();
      }
      const composerBounds = await interaction.locator('.composer').boundingBox();
      assert.ok(
        composerBounds.y + composerBounds.height <= 568,
        'Queued messages must leave the composer visible',
      );
      const queue = interaction.getByRole('region', { name: 'Queued messages' });
      assert.ok(
        await queue.evaluate((el) => el.scrollHeight > el.clientHeight),
        'A long queue must scroll inside its own area',
      );
      await interaction
        .getByRole('button', { name: 'Remove queued message 9', exact: true })
        .click();
      await expect(queue.locator('.queue-heading')).toContainText('8 queued');
      await interaction.screenshot({
        path: join(output, 'queue-layout-320.png'),
        animations: 'disabled',
      });
    } finally {
      await interaction.close();
    }
  }
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  assert.equal(overflow, false, 'Mobile must not overflow horizontally');
  assert.deepEqual(errors, [], 'No browser, hydration or CSP errors');
  console.log(
    JSON.stringify(
      {
        passed: true,
        connections,
        userMessages: received.filter((m) => m.type === 'user_message').length,
        screenshots: output,
        browserErrors: errors,
        themeContrasts,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
  for (const client of clients) client.terminate();
  await new Promise((resolve) => wss.close(resolve));
  await new Promise((resolve) => server.close(resolve));
}
