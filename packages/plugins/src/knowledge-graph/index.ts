/**
 * knowledge-graph plugin — accumulates structured facts about the project
 * across sessions.
 *
 * The plugin gives the agent three tools:
 *  - `kg_add_fact`    — add a (subject, relation, object) triple
 *  - `kg_query`       — query facts by subject, relation, or object
 *  - `kg_remove_fact` — remove a fact by id
 *  - `kg_status`      — counters + persisted path
 *
 * Facts persist in a project-local JSON file (default:
 * `<projectDir>/.wrongstack/knowledge-graph.json`) so they survive across
 * sessions. Optionally the plugin can contribute a compact summary of
 * relevant facts to the system prompt for the current task.
 *
 * Config (`config.extensions['knowledge-graph']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "filePath": ".wrongstack/knowledge-graph.json",
 *   "maxFacts": 200,
 *   "maxFactChars": 300,
 *   "contributeToSystemPrompt": true,
 *   "contributeMaxChars": 1500
 * }
 * ```
 *
 * @public
 */

import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';
import { atomicWrite, ensureDir } from '@wrongstack/core/utils';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

export interface Fact {
  id: string;
  subject: string;
  relation: string;
  object: string;
  source: string | null;
  confidence: 'low' | 'medium' | 'high';
  createdAt: string;
}

interface KnowledgeGraphState {
  facts: Fact[];
  nextId: number;
  adds: number;
  removals: number;
  queries: number;
  persistErrors: number;
  contributorUnregister: null | (() => void);
}

const state: KnowledgeGraphState = {
  facts: [],
  nextId: 1,
  adds: 0,
  removals: 0,
  queries: 0,
  persistErrors: 0,
  contributorUnregister: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface KnowledgeGraphConfig {
  enabled: boolean;
  filePath: string;
  maxFacts: number;
  maxFactChars: number;
  contributeToSystemPrompt: boolean;
  contributeMaxChars: number;
}

const DEFAULTS: KnowledgeGraphConfig = {
  enabled: true,
  filePath: '.wrongstack/knowledge-graph.json',
  maxFacts: 200,
  maxFactChars: 300,
  contributeToSystemPrompt: true,
  contributeMaxChars: 1_500,
};

function resolveProjectPath(rawPath: string, cwd = process.cwd()): string | null {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
  const root = resolve(cwd);
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  // Containment: the store both READS and WRITES this file, so a config-
  // controlled path that escapes the project root (an absolute path or `..`
  // traversal) would turn fact persistence into arbitrary-file I/O. Reject
  // anything outside the root — including the root directory itself.
  const rel = relative(root, resolved);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return resolved;
}

function readConfig(raw: unknown): KnowledgeGraphConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const rawPath =
    typeof r['filePath'] === 'string'
      ? r['filePath']
      : typeof r['file_path'] === 'string'
        ? r['file_path']
        : typeof r['path'] === 'string'
          ? r['path']
          : typeof r['file'] === 'string'
            ? r['file']
            : DEFAULTS.filePath;
  const rawMaxFacts = r['maxFacts'] ?? r['max_facts'] ?? r['limit'];
  const rawMaxFactChars =
    r['maxFactChars'] ?? r['max_fact_chars'] ?? r['maxChars'] ?? r['max_chars'];
  const rawContribute =
    r['contributeToSystemPrompt'] ?? r['contribute_to_system_prompt'] ?? r['contribute'];
  const rawContributeMax = r['contributeMaxChars'] ?? r['contribute_max_chars'];
  return {
    enabled: r['enabled'] !== false,
    filePath: typeof rawPath === 'string' ? rawPath : DEFAULTS.filePath,
    maxFacts:
      typeof rawMaxFacts === 'number' && rawMaxFacts >= 1 && rawMaxFacts <= 2000
        ? rawMaxFacts
        : DEFAULTS.maxFacts,
    maxFactChars:
      typeof rawMaxFactChars === 'number' && rawMaxFactChars >= 20
        ? rawMaxFactChars
        : DEFAULTS.maxFactChars,
    contributeToSystemPrompt: rawContribute !== false,
    contributeMaxChars:
      typeof rawContributeMax === 'number' && rawContributeMax >= 100
        ? rawContributeMax
        : DEFAULTS.contributeMaxChars,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function loadFacts(filePath: string): { facts: Fact[]; nextId: number } {
  if (!filePath) return { facts: [], nextId: 1 };
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as {
      facts?: unknown;
      nextId?: unknown;
    };
    const facts = Array.isArray(raw.facts)
      ? raw.facts.filter(
          (f): f is Fact =>
            !!f &&
            typeof f === 'object' &&
            typeof (f as Fact).id === 'string' &&
            typeof (f as Fact).subject === 'string' &&
            typeof (f as Fact).relation === 'string' &&
            typeof (f as Fact).object === 'string',
        )
      : [];
    const maxExistingId = facts.reduce((max, f) => {
      const n = parseInt(f.id.replace(/^\D+/, ''), 10);
      return Number.isFinite(n) && n > max ? n : max;
    }, 0);
    const nextId =
      typeof raw.nextId === 'number' && raw.nextId >= 1 ? raw.nextId : maxExistingId + 1;
    return { facts, nextId };
  } catch {
    return { facts: [], nextId: 1 };
  }
}

async function persistFacts(filePath: string): Promise<boolean> {
  if (!filePath) return true;
  try {
    // Atomic tmp+rename so a crash mid-write can't tear the fact store.
    //
    // Uses the shared primitive rather than a local `renameSync`: on Windows
    // that rename fails EPERM/EBUSY whenever an antivirus scanner or a
    // concurrent reader holds the destination open, and the fact write was
    // simply lost. The shared helper retries across ~4s first.
    await ensureDir(dirname(filePath));
    await atomicWrite(
      filePath,
      JSON.stringify({ facts: state.facts, nextId: state.nextId }, null, 2),
    );
    return true;
  } catch {
    state.persistErrors += 1;
    return false;
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'knowledge-graph',
  version: '0.1.0',
  description:
    'Accumulates structured (subject, relation, object) facts about the project and queries them across sessions',
  apiVersion: API_VERSION,
  capabilities: { tools: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean', default: true, description: 'Master switch.' },
      filePath: {
        type: 'string',
        default: '.wrongstack/knowledge-graph.json',
        description: 'Project-local JSON file where facts persist.',
      },
      maxFacts: {
        type: 'number',
        minimum: 1,
        maximum: 2000,
        default: 200,
        description: 'Maximum number of facts stored.',
      },
      maxFactChars: {
        type: 'number',
        minimum: 20,
        default: 300,
        description: 'Per-field length cap (subject, relation, object).',
      },
      contributeToSystemPrompt: {
        type: 'boolean',
        default: true,
        description: 'Inject a compact fact summary into the system prompt.',
      },
      contributeMaxChars: {
        type: 'number',
        minimum: 100,
        default: 1_500,
        description: 'Maximum chars contributed to the system prompt.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 audit pattern).
    state.adds = 0;
    state.removals = 0;
    state.queries = 0;
    state.persistErrors = 0;
    if (state.contributorUnregister) {
      try {
        state.contributorUnregister();
      } catch {
        // best-effort
      }
      state.contributorUnregister = null;
    }

    const cfg = readConfig(api.config.extensions?.['knowledge-graph']);
    const resolved = resolveProjectPath(cfg.filePath) ?? '';
    const loaded = resolved ? loadFacts(resolved) : { facts: [], nextId: 1 };
    state.facts = loaded.facts.slice(0, cfg.maxFacts);
    state.nextId = loaded.nextId;

    // System prompt contributor: surface a few recent/high-confidence facts.
    if (cfg.enabled && cfg.contributeToSystemPrompt) {
      state.contributorUnregister = api.registerSystemPromptContributor(async () => {
        if (state.facts.length === 0) return [];
        const recent = [...state.facts]
          .filter((f) => f.confidence !== 'low')
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
          .slice(0, 20);
        if (recent.length === 0) return [];
        const lines = recent.map((f) => `- ${f.subject} ${f.relation} ${f.object}`);
        const text =
          '[project_knowledge]\n' +
          'Recorded facts about this project (most recent, medium/high confidence):\n' +
          lines.join('\n');
        const truncated =
          text.length > cfg.contributeMaxChars
            ? text.slice(0, cfg.contributeMaxChars) + '\n[truncated]'
            : text;
        return [{ type: 'text' as const, text: truncated }];
      });
    }

    // --- kg_add_fact ---
    api.tools.register({
      name: 'kg_add_fact',
      description:
        'Add a structured fact to the project knowledge graph. Facts persist across sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'The entity the fact is about.' },
          relation: { type: 'string', description: 'Relationship, e.g. "depends_on", "owned_by".' },
          object: { type: 'string', description: 'The related entity or value.' },
          source: {
            type: 'string',
            description: 'Where this fact came from (file path, conversation, tool result).',
          },
          confidence: {
            type: 'string',
            enum: ['low', 'medium', 'high'],
            description: 'How sure the agent is about this fact.',
          },
        },
        required: ['subject', 'relation', 'object'],
      },
      permission: 'auto',
      category: 'Memory',
      mutating: true,
      async execute(input: {
        subject: string;
        relation: string;
        object: string;
        source?: string | undefined;
        confidence?: 'low' | 'medium' | 'high' | undefined;
      }) {
        if (!cfg.enabled) return { ok: false, error: 'knowledge-graph is disabled' };
        if (state.facts.length >= cfg.maxFacts) {
          return {
            ok: false,
            error: `fact limit reached (${cfg.maxFacts}). Remove old facts first.`,
          };
        }

        const trim = (s: unknown) =>
          String(s ?? '')
            .trim()
            .slice(0, cfg.maxFactChars);
        const raw = input as Record<string, unknown>;
        const subject = trim(
          input.subject ??
            raw['entity'] ??
            raw['topic'] ??
            raw['sub'] ??
            raw['name'] ??
            raw['sourceEntity'],
        );
        const relation = trim(
          input.relation ??
            raw['predicate'] ??
            raw['rel'] ??
            raw['verb'] ??
            raw['relationship'] ??
            raw['action'],
        );
        const object = trim(
          input.object ??
            raw['target'] ??
            raw['val'] ??
            raw['value'] ??
            raw['obj'] ??
            raw['targetEntity'],
        );
        if (!subject || !relation || !object) {
          return { ok: false, error: 'subject, relation, and object are required' };
        }

        const rawConf =
          typeof input.confidence === 'string' ? input.confidence.trim().toLowerCase() : '';
        const confidence: 'low' | 'medium' | 'high' =
          rawConf === 'low' || rawConf === 'high' || rawConf === 'medium' ? rawConf : 'medium';

        const fact: Fact = {
          id: `kg-${state.nextId++}`,
          subject,
          relation,
          object,
          source: input.source ? String(input.source).slice(0, cfg.maxFactChars) : null,
          confidence,
          createdAt: new Date().toISOString(),
        };
        state.facts.push(fact);
        state.adds += 1;
        api.metrics.counter('adds');
        const persisted = await persistFacts(resolved);
        return { ok: true, fact, persisted, totalFacts: state.facts.length };
      },
    });

    // --- kg_query ---
    api.tools.register({
      name: 'kg_query',
      description:
        'Query the knowledge graph by subject, relation, object, or confidence. Returns matching facts.',
      inputSchema: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          relation: { type: 'string' },
          object: { type: 'string' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
          limit: { type: 'number', description: 'Max results (default 20).' },
        },
      },
      permission: 'auto',
      category: 'Memory',
      mutating: false,
      async execute(input: {
        subject?: string | undefined;
        relation?: string | undefined;
        object?: string | undefined;
        confidence?: 'low' | 'medium' | 'high' | undefined;
        limit?: number | undefined;
      }) {
        if (!cfg.enabled) return { ok: false, error: 'knowledge-graph is disabled' };
        state.queries += 1;
        const raw = input as Record<string, unknown>;
        const rawQ =
          (typeof raw['query'] === 'string' ? raw['query'] : undefined) ??
          (typeof raw['q'] === 'string' ? raw['q'] : undefined);
        const q = rawQ?.toLowerCase();
        const rawFilterConf =
          typeof input.confidence === 'string' ? input.confidence.trim().toLowerCase() : undefined;
        const filterConf =
          rawFilterConf === 'low' || rawFilterConf === 'medium' || rawFilterConf === 'high'
            ? rawFilterConf
            : undefined;
        const limit =
          typeof input.limit === 'number' && input.limit >= 1 ? Math.floor(input.limit) : 20;
        const matches = state.facts.filter((f) => {
          if (q) {
            const hasMatch =
              f.subject.toLowerCase().includes(q) ||
              f.relation.toLowerCase().includes(q) ||
              f.object.toLowerCase().includes(q);
            if (!hasMatch) return false;
          }
          if (input.subject && !f.subject.toLowerCase().includes(input.subject.toLowerCase()))
            return false;
          if (input.relation && !f.relation.toLowerCase().includes(input.relation.toLowerCase()))
            return false;
          if (input.object && !f.object.toLowerCase().includes(input.object.toLowerCase()))
            return false;
          if (filterConf && f.confidence.toLowerCase() !== filterConf) return false;
          return true;
        });
        const returnedFacts = matches.slice(-limit);
        return {
          ok: true,
          totalFacts: state.facts.length,
          returned: returnedFacts.length,
          facts: returnedFacts,
        };
      },
    });

    // --- kg_remove_fact ---
    api.tools.register({
      name: 'kg_remove_fact',
      description: 'Remove a fact from the knowledge graph by its id (kg-N).',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Fact id to remove.' },
        },
        required: ['id'],
      },
      permission: 'auto',
      category: 'Memory',
      mutating: true,
      async execute(input: { id: string }) {
        if (!cfg.enabled) return { ok: false, error: 'knowledge-graph is disabled' };
        const before = state.facts.length;
        const raw = (input ?? {}) as Record<string, unknown>;
        const rawId = String(input.id ?? raw['factId'] ?? raw['fact_id'] ?? '').trim();
        const normalized = rawId.toLowerCase().startsWith('kg-')
          ? rawId.toLowerCase()
          : `kg-${rawId.toLowerCase()}`;
        state.facts = state.facts.filter(
          (f) => f.id.toLowerCase() !== normalized && f.id !== rawId,
        );
        const removed = before - state.facts.length;
        if (removed === 0) return { ok: false, error: `no fact matches "${input.id ?? rawId}"` };
        state.removals += removed;
        api.metrics.counter('removals', removed);
        const persisted = await persistFacts(resolved);
        return { ok: true, removed, persisted, totalFacts: state.facts.length };
      },
    });

    // --- kg_status ---
    api.tools.register({
      name: 'kg_status',
      description: 'Reports knowledge-graph state: fact count, persisted path, and counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Memory',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          totalFacts: state.facts.length,
          maxFacts: cfg.maxFacts,
          filePath: cfg.filePath,
          resolvedPath: resolved || null,
          contributeToSystemPrompt: cfg.contributeToSystemPrompt,
          counters: {
            adds: state.adds,
            removals: state.removals,
            queries: state.queries,
            persistErrors: state.persistErrors,
          },
        };
      },
    });

    api.log.info('knowledge-graph plugin loaded', {
      version: '0.1.0',
      factsLoaded: state.facts.length,
      filePath: cfg.filePath,
    });
  },

  teardown(api) {
    if (state.contributorUnregister) {
      try {
        state.contributorUnregister();
      } catch {
        // best-effort
      }
      state.contributorUnregister = null;
    }
    const final = {
      facts: state.facts.length,
      adds: state.adds,
      removals: state.removals,
      queries: state.queries,
      persistErrors: state.persistErrors,
    };
    state.facts = [];
    state.nextId = 1;
    state.adds = 0;
    state.removals = 0;
    state.queries = 0;
    state.persistErrors = 0;
    api.log.info('knowledge-graph: teardown complete', { final });
  },

  async health() {
    return {
      ok: state.persistErrors === 0,
      message: `knowledge-graph: ${state.facts.length} fact(s), ${state.adds} add(s), ${state.queries} query(ies), ${state.persistErrors} persist error(s)`,
      counters: {
        facts: state.facts.length,
        adds: state.adds,
        removals: state.removals,
        queries: state.queries,
        persistErrors: state.persistErrors,
      },
    };
  },
};

export default plugin;
