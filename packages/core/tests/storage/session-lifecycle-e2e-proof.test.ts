import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractInterruptedTools, SessionRecovery } from '../../src/storage/session-recovery.js';
import { validateResumeFileObservations } from '../../src/storage/session-resume-validation.js';
import { DefaultSessionRewinder } from '../../src/storage/session-rewinder.js';
import { DefaultSessionStore } from '../../src/storage/session-store.js';
import type { SessionEvent } from '../../src/types/session.js';
import { isSystemInjectedMessage } from '../../src/types/session-markers.js';

describe('Session Lifecycle & Invariant Verification Suite (Code-Proven)', () => {
  let tmpDir: string;
  let projectDir: string;
  let store: DefaultSessionStore;
  let recovery: SessionRecovery;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'wstack-proof-'));
    projectDir = path.join(tmpDir, 'project');
    await fsp.mkdir(projectDir, { recursive: true });
    store = new DefaultSessionStore({ dir: tmpDir, projectRoot: projectDir });
    recovery = new SessionRecovery(tmpDir);
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('Proof 1: JSONL streaming, durable buffer flush, and summary tracking', async () => {
    const writer = await store.create({
      id: 'session-proof-1',
      title: 'Proof 1 Session',
      model: 'gpt-4o',
      provider: 'openai',
    });

    await writer.append({
      type: 'user_input',
      ts: '2026-08-14T10:00:00.000Z',
      content: 'Analyze codebase',
    });

    await writer.append({
      type: 'tool_call_start',
      ts: '2026-08-14T10:00:01.000Z',
      id: 'tc-1',
      name: 'read_file',
      input: { path: 'index.ts' },
    });

    await writer.append({
      type: 'tool_result',
      ts: '2026-08-14T10:00:02.000Z',
      id: 'tc-1',
      content: 'console.log("hello");',
      isError: false,
    });

    await writer.append({
      type: 'llm_response',
      ts: '2026-08-14T10:00:03.000Z',
      content: [{ type: 'text', text: 'Analysis completed.' }],
      stopReason: 'end_turn',
      usage: { input: 50, output: 20 },
    });

    await writer.flush();
    await writer.close();

    // Verify raw disk contents
    const raw = await fsp.readFile(path.join(tmpDir, 'session-proof-1.jsonl'), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(4);

    // Verify summary matches exactly
    const loaded = await store.load('session-proof-1');
    expect(loaded.metadata.model).toBe('gpt-4o');
    expect(loaded.usage.input).toBe(50);
    expect(loaded.usage.output).toBe(20);
    expect(loaded.messages.length).toBeGreaterThan(0);
  });

  it('Proof 2: Crash detection with stale in-flight marker and tool extraction', async () => {
    const sessionId = 'session-crashed';
    const lines = [
      {
        type: 'session_start',
        ts: '2026-08-14T10:00:00Z',
        id: sessionId,
        model: 'claude-3-7',
        provider: 'anthropic',
      },
      { type: 'user_input', ts: '2026-08-14T10:00:01Z', content: 'Run test command' },
      {
        type: 'in_flight_start',
        ts: '2026-08-14T10:00:02Z',
        context: 'Executing tool: run_command',
      },
      {
        type: 'tool_call_start',
        ts: '2026-08-14T10:00:03Z',
        id: 'call_cmd',
        name: 'run_command',
        input: { command: 'pnpm build' },
      },
      // Sudden crash occurs here (node.exe killed, no tool_result or in_flight_end)
    ];

    await fsp.writeFile(
      path.join(tmpDir, `${sessionId}.jsonl`),
      lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    );

    // Detect stale crash status
    const stale = await recovery.detectStale(sessionId);
    expect(stale).not.toBeNull();
    expect(stale?.sessionId).toBe(sessionId);
    expect(stale?.context).toBe('Executing tool: run_command');

    // Build recovery plan and extract interrupted tools
    const plan = await recovery.recover(sessionId);
    expect(plan?.stale).toBe(true);
    const interrupted = extractInterruptedTools(plan!);
    expect(interrupted).toHaveLength(1);
    expect(interrupted[0]?.name).toBe('run_command');
    expect(interrupted[0]?.argsSummary).toContain('pnpm build');
  });

  it('Proof 3: Torn line recovery and orphan tool repair on resume', async () => {
    const sessionId = 'session-torn-line';
    const validLines = [
      JSON.stringify({
        type: 'session_start',
        ts: '2026-08-14T10:00:00Z',
        id: sessionId,
        model: 'm',
        provider: 'p',
      }),
      JSON.stringify({ type: 'user_input', ts: '2026-08-14T10:00:01Z', content: 'Hello' }),
      JSON.stringify({
        type: 'llm_response',
        ts: '2026-08-14T10:00:02Z',
        content: [
          { type: 'text', text: 'Let me read the file' },
          { type: 'tool_use', id: 'orphan_tool_1', name: 'read_file', input: { path: 'a.txt' } },
        ],
        stopReason: 'tool_use',
        usage: { input: 10, output: 10 },
      }),
    ];
    // Append a torn/corrupted half-line (simulating process death mid-write)
    const tornFile =
      validLines.join('\n') + '\n{"type":"tool_result","ts":"2026-08-14T10:00:03Z","id":"orpha';
    await fsp.writeFile(path.join(tmpDir, `${sessionId}.jsonl`), tornFile);

    // Resume must succeed without crashing on torn line, and repair orphan tool
    const resumed = await store.resume(sessionId);
    expect(resumed.data.metadata.id).toBe(sessionId);
    expect(resumed.data.messages.length).toBeGreaterThan(0);
    // Pending tool uses should be reported so notification is displayed
    expect(resumed.data.pendingToolUseCount).toBe(1);

    await resumed.writer.close();
  });

  it('Proof 4: External file modification validation on session resume', async () => {
    const targetFile = path.join(projectDir, 'service.ts');
    await fsp.writeFile(targetFile, 'const port = 3000;\n');

    // Simulate session that observed service.ts
    const events: SessionEvent[] = [
      {
        type: 'file_observation',
        ts: '2026-08-14T10:00:00Z',
        path: 'service.ts',
        hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', // mismatch hash
        mtimeMs: 0,
        source: 'write',
      },
    ];

    const validation = await validateResumeFileObservations(events, projectDir);
    expect(validation.staleFiles.length).toBe(1);
    expect(validation.staleFiles[0]?.status).toBe('modified');
    expect(validation.staleFiles[0]?.path).toBe(targetFile);
  });

  it('Proof 5: Chat history replay cleans all runtime internal injections', () => {
    const systemInjections = [
      '[MAILBOX] New message from agent leader',
      '[MAILBOX BTW] Background contextual clue',
      '[FLEET PULSE] 3 agents online',
      '[loop-detector] detected repetition',
      '[BY THE WAY — keep this in mind',
      '[QUEUED MESSAGES — 1 task pending',
      '[tool_history_digest: 40 older acknowledged exchange(s) omitted',
      '[session.resume] Request targeted session 2026-08-26/sess_old, but this WebUI runtime is currently on 2026-08-26/sess_a.',
    ];

    for (const injection of systemInjections) {
      expect(isSystemInjectedMessage(injection)).toBe(true);
    }

    // The resume notices are NOT injections: the store writes them for the
    // HUMAN, to say files moved underneath the session or calls were left in
    // flight. Hiding them meant the drift was detected, worded, and then
    // silently discarded on every surface.
    const humanFacingResumeNotices = [
      '[SESSION RESUME FILE VALIDATION] 2 files changed',
      '[SESSION RESUME INTERRUPTED WORK] 1 tool call was in flight',
      '[SESSION RESUME CRASH RECOVERY] The previous run stopped mid-iteration',
    ];

    for (const notice of humanFacingResumeNotices) {
      expect(isSystemInjectedMessage(notice)).toBe(false);
    }

    const realUserMessages = [
      'Please refactor the database module',
      'How does the auth flow work?',
      'Run the test suite and fix any errors',
    ];

    for (const userMsg of realUserMessages) {
      expect(isSystemInjectedMessage(userMsg)).toBe(false);
    }
  });

  it('Proof 6: Truncate to checkpoint removes subsequent prompts and keeps target era', async () => {
    const sessionId = 'session-trunc-proof';
    const lines = [
      JSON.stringify({
        type: 'session_start',
        ts: '2026-08-14T10:00:00Z',
        id: sessionId,
        model: 'm',
        provider: 'p',
      }),
      JSON.stringify({
        type: 'user_input',
        ts: '2026-08-14T10:00:01Z',
        content: 'prompt 0',
        promptIndex: 0,
      }),
      JSON.stringify({ type: 'checkpoint', ts: '2026-08-14T10:00:02Z', promptIndex: 0 }),
      JSON.stringify({
        type: 'user_input',
        ts: '2026-08-14T10:00:03Z',
        content: 'prompt 1',
        promptIndex: 1,
      }),
      JSON.stringify({ type: 'checkpoint', ts: '2026-08-14T10:00:04Z', promptIndex: 1 }),
      JSON.stringify({
        type: 'user_input',
        ts: '2026-08-14T10:00:05Z',
        content: 'prompt 2',
        promptIndex: 2,
      }),
    ];
    await fsp.writeFile(path.join(tmpDir, `${sessionId}.jsonl`), lines.join('\n') + '\n');

    const rewinder = new DefaultSessionRewinder(tmpDir, projectDir);
    const checkpoints = await rewinder.listCheckpoints(sessionId);
    expect(checkpoints).toHaveLength(2);

    // Truncate to promptIndex 0
    const resumed = await store.resume(sessionId);
    const removedCount = await resumed.writer.truncateToCheckpoint(0);
    await resumed.writer.close();

    expect(removedCount).toBe(3); // prompt 1 input, prompt 1 checkpoint, prompt 2 input

    const raw = await fsp.readFile(path.join(tmpDir, `${sessionId}.jsonl`), 'utf8');
    expect(raw).toContain('prompt 0');
    expect(raw).not.toContain('prompt 1');
    expect(raw).not.toContain('prompt 2');
    expect(raw).toContain('rewound');
  });

  it('Proof 7: Fork inherits the latest model/provider identity across resumes', async () => {
    const parentId = 'session-parent';
    const lines = [
      JSON.stringify({
        type: 'session_start',
        ts: '2026-08-14T10:00:00Z',
        id: parentId,
        model: 'gpt-4o',
        provider: 'openai',
      }),
      JSON.stringify({
        type: 'user_input',
        ts: '2026-08-14T10:00:01Z',
        content: 'Initial work',
        promptIndex: 0,
      }),
      JSON.stringify({
        type: 'session_resumed',
        ts: '2026-08-14T10:05:00Z',
        id: parentId,
        model: 'claude-3-7-sonnet',
        provider: 'anthropic',
      }),
      JSON.stringify({
        type: 'user_input',
        ts: '2026-08-14T10:05:01Z',
        content: 'Continue work with Claude',
        promptIndex: 1,
      }),
      JSON.stringify({ type: 'checkpoint', ts: '2026-08-14T10:05:02Z', promptIndex: 1 }),
    ];
    await fsp.writeFile(path.join(tmpDir, `${parentId}.jsonl`), lines.join('\n') + '\n');

    // Fork the parent session
    const forked = await store.fork(parentId);
    expect(forked.data.metadata.model).toBe('claude-3-7-sonnet');
    expect(forked.data.metadata.provider).toBe('anthropic');
  });
});
