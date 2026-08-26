import { agentPrompt } from './agent-prompts.js';
import type { BundledAgentSkill } from './role-skills.js';
import {
  type AgentDefinition,
  HEAVY_BUDGET,
  MEDIUM_BUDGET,
  type RoleDispatcherSignal,
  TOOLS,
} from './types.js';

const skillSet = (...names: BundledAgentSkill[]): BundledAgentSkill[] => names;

/**
 * Wave 3: Product and data specialists.
 *
 * Six roles that own areas the existing 51-role catalog only touches
 * generically. Each carries an explicit `RoleDispatcherSignal` so the
 * dispatcher can disambiguate from close siblings.
 */

const PAYMENTS_META = {
  rationale:
    'Payments specialist: ledger, refund, webhook, idempotency, reconciliation. Financial correctness is too domain-specific to leave to a general backend role.',
  signals: [
    'payments',
    'ledger',
    'refund',
    'webhook',
    'idempotency',
    'reconciliation',
    'pci',
    'currency',
  ] as const,
  differentiatesFrom:
    'backend builds services; payments owns the financial-correctness invariants and money-handling patterns.',
} satisfies RoleDispatcherSignal;

const MESSAGING_META = {
  rationale:
    'Messaging infrastructure specialist: queue, pub/sub, delivery semantics, DLQ. Owns distributed-messaging failure modes that the distributed-systems role designs but does not implement.',
  signals: [
    'messaging',
    'queue',
    'pubsub',
    'dead letter',
    'dlq',
    'delivery semantics',
    'at-least-once',
    'at-most-once',
    'kafka',
  ] as const,
  differentiatesFrom:
    'distributed-systems designs the failure semantics; messaging implements the broker and consumer infrastructure.',
} satisfies RoleDispatcherSignal;

const SEARCH_RELEVANCE_META = {
  rationale:
    'Search relevance specialist: indexing, ranking, retrieval, evaluation. Owns the offline and online quality metrics that a generic database role does not.',
  signals: [
    'search',
    'search relevance',
    'ranking',
    'retrieval',
    'indexing',
    'recall',
    'precision',
    'reranker',
  ] as const,
  differentiatesFrom:
    'database stores rows; search-relevance owns the ranking, retrieval and relevance-evaluation pipeline.',
} satisfies RoleDispatcherSignal;

const STORAGE_META = {
  rationale:
    'Object-storage specialist: upload, checksum, lifecycle, CDN. Owns the durability and replication boundaries of blob data.',
  signals: [
    'object storage',
    'blob',
    'upload',
    'checksum',
    'lifecycle',
    'cdn',
    'presigned url',
    'multipart upload',
  ] as const,
  differentiatesFrom:
    'database owns structured rows; storage owns unstructured blob lifecycle and replication.',
} satisfies RoleDispatcherSignal;

const ML_ENGINEER_META = {
  rationale:
    'ML engineer: model integration, inference, evaluation, guardrail. The catalog has no existing ML-application specialist.',
  signals: [
    'ml',
    'machine learning',
    'inference',
    'embedding',
    'model evaluation',
    'guardrail',
    'llm evaluation',
  ] as const,
  differentiatesFrom:
    'data builds pipelines; ml-engineer integrates models, evaluates them and wires guardrails.',
} satisfies RoleDispatcherSignal;

const DATA_GOVERNANCE_META = {
  rationale:
    'Data governance specialist: lineage, classification, ownership, data contracts. Owns accountability and quality-of-record for data assets.',
  signals: [
    'data governance',
    'lineage',
    'classification',
    'ownership',
    'data contract',
    'data quality',
    'retention policy',
  ] as const,
  differentiatesFrom:
    'data builds pipelines; data-governance owns accountability, lineage and the data contracts that bind them.',
} satisfies RoleDispatcherSignal;

export const WAVE3_AGENTS: AgentDefinition[] = [
  {
    config: {
      id: 'payments',
      name: 'Payments',
      role: 'payments',
      tools: [...new Set([...TOOLS.build, ...TOOLS.write, ...TOOLS.inspect, 'fetch'])],
      prompt: agentPrompt('payments'),
    },
    budget: HEAVY_BUDGET,
    capability: {
      phase: 'domain',
      summary:
        'Payments specialist: ledger, refund, webhook, idempotency and reconciliation with financial-correctness invariants.',
      rationale: PAYMENTS_META,
      keywords: [
        ...PAYMENTS_META.signals,
        'payments',
        'ledger',
        'refund',
        'webhook',
        'idempotency',
        'pci',
      ],
    },
  },
  {
    config: {
      id: 'messaging',
      name: 'Messaging',
      role: 'messaging',
      tools: [...TOOLS.build, 'logs'],
      prompt: agentPrompt('messaging'),
    },
    budget: HEAVY_BUDGET,
    capability: {
      phase: 'domain',
      summary:
        'Messaging infrastructure specialist: queue, pub/sub, delivery semantics and DLQ with broker failure modes.',
      rationale: MESSAGING_META,
      keywords: [
        ...MESSAGING_META.signals,
        'messaging',
        'queue',
        'pubsub',
        'dlq',
        'kafka',
        'rabbitmq',
      ],
    },
  },
  {
    config: {
      id: 'search-relevance',
      name: 'Search Relevance',
      role: 'search-relevance',
      tools: [...TOOLS.build, 'logs'],
      prompt: agentPrompt('search-relevance'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'domain',
      summary:
        'Search relevance specialist: indexing, ranking, retrieval and offline/online evaluation of search quality.',
      rationale: SEARCH_RELEVANCE_META,
      keywords: [
        ...SEARCH_RELEVANCE_META.signals,
        'search',
        'ranking',
        'retrieval',
        'indexing',
        'recall',
        'rerank',
      ],
    },
  },
  {
    config: {
      id: 'storage',
      name: 'Storage',
      role: 'storage',
      tools: [...TOOLS.build, 'fetch', 'logs'],
      prompt: agentPrompt('storage'),
    },
    budget: HEAVY_BUDGET,
    capability: {
      phase: 'domain',
      summary:
        'Object-storage specialist: upload, checksum, lifecycle, CDN and replication for unstructured blob data.',
      rationale: STORAGE_META,
      keywords: [
        ...STORAGE_META.signals,
        'object-storage',
        'blob',
        'upload',
        'checksum',
        'lifecycle',
        'cdn',
      ],
    },
  },
  {
    config: {
      id: 'ml-engineer',
      name: 'ML Engineer',
      role: 'ml-engineer',
      tools: [...TOOLS.build, 'logs'],
      prompt: agentPrompt('ml-engineer'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'domain',
      summary: 'ML engineer: model integration, inference, evaluation and guardrail wiring.',
      rationale: ML_ENGINEER_META,
      keywords: [
        ...ML_ENGINEER_META.signals,
        'ml',
        'inference',
        'embedding',
        'guardrail',
        'llm-eval',
      ],
    },
  },
  {
    config: {
      id: 'data-governance',
      name: 'Data Governance',
      role: 'data-governance',
      tools: [...TOOLS.read, 'write', 'audit'],
      prompt: agentPrompt('data-governance'),
    },
    budget: MEDIUM_BUDGET,
    capability: {
      phase: 'domain',
      summary:
        'Data governance specialist: lineage, classification, ownership and data contracts with quality-of-record.',
      rationale: DATA_GOVERNANCE_META,
      keywords: [
        ...DATA_GOVERNANCE_META.signals,
        'data-governance',
        'lineage',
        'classification',
        'data-contract',
        'retention',
      ],
    },
  },
];

void skillSet;
