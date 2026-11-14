import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Request } from '@wrongstack/contracts/types/provider';
import { loadRuntimeDatabaseSync } from '@wrongstack/persistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARCHITECTURE_DECISION_CONTEXT } from '../../src/core/agent-coordination.js';
import type { AgentInternals } from '../../src/core/agent-internals.js';
import { createAgentResponseHandler } from '../../src/core/agent-response.js';
import { storageArchitectureDecisionContext } from '../../src/storage/architecture-decision-checks.js';
import {
  rememberWarnedRoot,
  WARNED_PROJECT_ROOTS_CAP,
} from '../../src/storage/architecture-decision-context.js';
import { ArchitectureDecisionStore } from '../../src/storage/architecture-decision-store.js';

/** The binding the runtime container makes; the agent loop only resolves the port. */
const decisionContainer = {
  has: (token: unknown) => token === ARCHITECTURE_DECISION_CONTEXT,
  resolve: () => storageArchitectureDecisionContext,
};

import { createContextEvidenceState } from '../../src/utils/context-evidence.js';

describe('architecture decisions on the real provider request boundary', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'adr-request-'));
    vi.stubEnv('WRONGSTACK_HOME', path.join(dir, 'home'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });
  it.each([false, true])(
    'runs approved file checks on the actual provider boundary (owned=%s)',
    async (owned) => {
      const root = path.join(dir, 'checked-project');
      mkdirSync(root);
      writeFileSync(path.join(root, 'contract.txt'), 'required');
      const store = new ArchitectureDecisionStore(root);
      const record = store.propose(
        {
          title: 'Marker',
          context: 'Public contract.',
          decision: 'Keep the marker.',
          alternatives: [],
          consequences: [],
          constraints: [],
          scope: [],
          revisitWhen: '',
          checks: [{ id: 'marker', kind: 'contains_text', path: 'contract.txt', text: 'required' }],
        },
        'agent',
      );
      store.review(
        {
          projectId: record.projectId,
          id: record.id,
          revision: record.revision,
          contentHash: record.contentHash,
          action: 'accept',
          reason: 'Reviewed marker check.',
        },
        'user',
      );
      const ctx = {
        agentId: 'worker',
        projectRoot: root,
        todos: [],
        tools: [],
        catalogTools: [],
        systemPrompt: [{ type: 'text', text: 'Stable prompt' }],
        memoryEvidence: [],
        messages: [{ role: 'user', content: 'Work' }],
        meta: {},
        contextEvidence: createContextEvidenceState(),
        toolAdjacencyDirty: false,
        provider: { id: 'fixture', capabilities: { keepsOwnContext: owned, cacheControl: 'none' } },
        model: 'fixture',
        session: { id: 'fixture' },
        waitForModelTransition: async () => {},
      } as unknown as AgentInternals['ctx'];
      const read = {
        name: 'read',
        description: 'Read.',
        permission: 'auto',
        mutating: false,
        inputSchema: { type: 'object' },
        execute: async () => '',
      };
      const agent = {
        ctx,
        container: decisionContainer,
        tools: { get: () => read, list: () => [], listForProvider: () => [] },
        permission: { explain: async () => ({ decision: { permission: 'auto' } }) },
        pipelines: { request: { run: async (r: Request) => r } },
        events: { emit() {} },
        logger: { warn() {} },
      } as unknown as AgentInternals;
      const handler = createAgentResponseHandler(agent);
      const first = (await handler.buildAndRunRequestPipeline({})).request;
      expect(JSON.stringify(first.messages)).toContain('check result: pass');
      writeFileSync(path.join(root, 'contract.txt'), 'changed');
      const second = (await handler.buildAndRunRequestPipeline({})).request;
      expect(JSON.stringify(second.messages)).toContain('check result: fail');
      expect(second.system).toEqual(first.system);
      expect(JSON.stringify(ctx.messages)).not.toContain('check result:');
    },
  );

  it.each([
    ['leader', 'native', false],
    ['worker-1', 'none', false],
    ['worker-2', 'auto', false],
    ['leader', 'none', true],
  ] as const)(
    'refreshes reviewed decisions for %s / %s / owned=%s and preserves the stable prompt',
    async (agentId, cacheControl, keepsOwnContext) => {
      const projectRoot = path.join(dir, 'project');
      const store = new ArchitectureDecisionStore(projectRoot);
      const pending = store.propose(
        {
          title: 'Mandatory architecture boundary',
          context: 'Keep modules independent.',
          decision: 'Ports must be defined in contracts.',
          alternatives: [],
          consequences: [],
          constraints: ['Do not import implementations into contracts.'],
          scope: [],
          revisitWhen: '',
        },
        'agent',
      );
      const ctx = {
        agentId,
        projectRoot,
        workingDir: path.join(projectRoot, 'packages/core'),
        todos: [],
        tools: [],
        catalogTools: [],
        systemPrompt: [{ type: 'text', text: 'Stable special-purpose agent prompt' }],
        memoryEvidence: [],
        messages: [{ role: 'user', content: 'Work on the module' }],
        meta: {},
        contextEvidence: createContextEvidenceState(),
        toolAdjacencyDirty: false,
        provider: { id: 'test', capabilities: { cacheControl, keepsOwnContext } },
        model: 'test',
        session: { id: 'fixture-session' },
        waitForModelTransition: async () => {},
      } as unknown as AgentInternals['ctx'];
      const agent = {
        ctx,
        container: decisionContainer,
        tools: { listForProvider: () => [], list: () => [] },
        pipelines: { request: { run: async (r: Request) => r } },
        events: { emit() {} },
        logger: { warn() {} },
      } as unknown as AgentInternals;
      const handler = createAgentResponseHandler(agent);
      const first = (await handler.buildAndRunRequestPipeline({})).request;
      expect(JSON.stringify(first)).not.toContain(pending.decision);
      const accepted = store.review(
        {
          projectId: pending.projectId,
          id: pending.id,
          revision: pending.revision,
          contentHash: pending.contentHash,
          action: 'accept',
          reason: 'Reviewed the boundary.',
        },
        'user',
      );
      // Simulates the history rewrite at compaction without replacing this handler or its prompt epoch.
      ctx.messages = [{ role: 'user', content: 'Compacted conversation summary' }];
      const next = (await handler.buildAndRunRequestPipeline({})).request;
      expect(JSON.stringify(next.messages)).toContain(accepted.decision);
      expect(JSON.stringify(ctx.messages)).not.toContain(accepted.decision);
      expect(next.system).toEqual(first.system);
      expect(ctx.meta.architectureDecisionSnapshot).toEqual([
        { id: accepted.id, revision: accepted.revision, contentHash: accepted.contentHash },
      ]);
      store.review(
        {
          projectId: accepted.projectId,
          id: accepted.id,
          revision: accepted.revision,
          contentHash: accepted.contentHash,
          action: 'deprecate',
          reason: 'No longer applies.',
        },
        'user',
      );
      const retired = (await handler.buildAndRunRequestPipeline({})).request;
      expect(ctx.meta.architectureDecisionSnapshot).toEqual([]);
      // On automatic-cache wires earlier snapshots remain historical context; the last snapshot is current.
      expect(JSON.stringify(retired.messages.at(-1))).toContain('Active decisions: 0');
    },
  );
});

describe('an ADR store that cannot be read', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'adr-request-broken-'));
    vi.stubEnv('WRONGSTACK_HOME', path.join(dir, 'home'));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * The ADR registry is a sqlite file that can be uninitialized, corrupt or
   * written by a newer WrongStack. Reading it must never take the request
   * down with it: the request goes out without the ADR block instead.
   */
  it.each([
    ['native', false],
    ['owned', true],
  ] as const)(
    'still builds the %s request without the ADR block when the store throws',
    async (_wire, keepsOwnContext) => {
      const projectRoot = path.join(dir, 'project');
      const store = new ArchitectureDecisionStore(projectRoot);
      // A database file that exists but was never initialized: reading it
      // throws ("ADR database is uninitialized").
      mkdirSync(path.dirname(store.file), { recursive: true });
      const Database = loadRuntimeDatabaseSync();
      const db = new Database(store.file);
      db.exec('CREATE TABLE placeholder (id TEXT PRIMARY KEY)');
      db.close();
      expect(() => store.list()).toThrow(/uninitialized|newer schema/);

      const ctx = {
        agentId: 'leader',
        projectRoot,
        workingDir: path.join(projectRoot, 'packages/core'),
        todos: [],
        tools: [],
        catalogTools: [],
        systemPrompt: [{ type: 'text', text: 'Stable special-purpose agent prompt' }],
        memoryEvidence: [],
        messages: [{ role: 'user', content: 'Work on the module' }],
        meta: {},
        contextEvidence: createContextEvidenceState(),
        toolAdjacencyDirty: false,
        provider: { id: 'test', capabilities: { cacheControl: 'none', keepsOwnContext } },
        model: 'test',
        session: { id: 'fixture-session' },
        waitForModelTransition: async () => {},
      } as unknown as AgentInternals['ctx'];
      const agent = {
        ctx,
        container: decisionContainer,
        tools: { listForProvider: () => [], list: () => [] },
        pipelines: { request: { run: async (r: Request) => r } },
        events: { emit() {} },
        logger: { warn: vi.fn() },
      } as unknown as AgentInternals;
      const handler = createAgentResponseHandler(agent);

      const request = (await handler.buildAndRunRequestPipeline({})).request;

      // The request is built, and it carries no architecture decisions.
      expect(JSON.stringify(request)).not.toContain('project_architecture_decisions');
      expect(ctx.meta.architectureDecisionSnapshot).toEqual([]);
      // The failure is reported, once — not swallowed silently.
      expect(agent.logger.warn).toHaveBeenCalledTimes(1);
    },
  );
});

describe('rememberWarnedRoot warn-once bound', () => {
  it('warns once per root and then stays silent', () => {
    const set = new Set<string>();
    expect(rememberWarnedRoot(set, 'a', 256)).toBe(true);
    expect(rememberWarnedRoot(set, 'a', 256)).toBe(false);
    expect(set.size).toBe(1);
  });

  it('clears the set when the cap is reached, keeping size <= cap', () => {
    const cap = 4;
    const set = new Set<string>();
    const decisions: boolean[] = [];
    for (let i = 0; i < cap + 2; i++) {
      decisions.push(rememberWarnedRoot(set, `root-${i}`, cap));
    }
    // First cap roots warn; after the clear, new roots warn again.
    expect(decisions).toEqual([...Array.from({ length: cap }, () => true), true, true]);
    expect(set.size).toBeLessThanOrEqual(cap);
    expect(set.size).toBe(2);
  });

  it('matches the exported production cap constant', () => {
    expect(WARNED_PROJECT_ROOTS_CAP).toBe(256);
    const set = new Set<string>();
    for (let i = 0; i < WARNED_PROJECT_ROOTS_CAP + 1; i++) {
      rememberWarnedRoot(set, `root-${i}`, WARNED_PROJECT_ROOTS_CAP);
    }
    expect(set.size).toBeLessThanOrEqual(WARNED_PROJECT_ROOTS_CAP);
  });
});
