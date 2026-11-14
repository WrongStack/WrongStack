import type { Tool } from '@wrongstack/contracts/types';
import {
  type ArchitectureDecisionContent,
  ArchitectureDecisionStore,
} from '@wrongstack/core/storage';

interface DecisionInput {
  action: 'list' | 'get' | 'propose' | 'revise';
  id?: string;
  revision?: number;
  contentHash?: string;
  proposal?: ArchitectureDecisionContent;
}

/** Deliberately has no accept/reject/deprecate action: those belong to the user UI. */
export const architectureDecisionsTool: Tool<DecisionInput, unknown> = {
  name: 'architecture_decisions',
  category: 'Session',
  icon: 'brain',
  description:
    'Read project Architecture Decision Records or propose a lasting architecture choice for user review. Proposals are inactive until the user accepts the exact revision in /adr. Identical proposals are deduplicated, including rejected ones. Never use a memory entry as ADR approval.',
  usageHint:
    'Use list/get before proposing. Provide the rationale, alternatives, consequences and scoped constraints. Revise only pending proposals using the observed revision/hash. Tell the user to review in /adr; never infer acceptance from silence or a tool permission grant.',
  selection: {
    doNotUseWhen:
      'The information is a temporary observation, ordinary task status, or an unreviewed fact rather than a lasting architecture choice.',
    useInstead: ['remember'],
  },
  permission: 'confirm',
  // Reads and proposals are approved separately, as the design tool does.
  subjectKey: 'action',
  mutating: true,
  capabilities: ['memory.read', 'memory.write'],
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'get', 'propose', 'revise'],
        description: 'Read existing ADRs or propose/revise an inactive decision for user review.',
      },
      id: { type: 'string', description: 'ADR id for get.' },
      revision: { type: 'integer', minimum: 1, description: 'Expected revision for revise.' },
      contentHash: { type: 'string', description: 'Expected content hash for revise.' },
      proposal: {
        type: 'object',
        description:
          'Complete ADR content; optional checks are part of the content the user approves.',
        properties: {
          title: { type: 'string', maxLength: 200 },
          context: { type: 'string', maxLength: 8000 },
          decision: { type: 'string', maxLength: 8000 },
          alternatives: { type: 'array', items: { type: 'string' }, maxItems: 32 },
          consequences: { type: 'array', items: { type: 'string' }, maxItems: 32 },
          constraints: { type: 'array', items: { type: 'string' }, maxItems: 32 },
          scope: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Project-relative files/directories, no globs. Empty applies to the entire project.',
            maxItems: 32,
          },
          revisitWhen: { type: 'string', maxLength: 2000 },
          supersedes: {
            type: 'string',
            description: 'Accepted ADR id this proposal would replace.',
          },
          checks: {
            type: 'array',
            maxItems: 16,
            description:
              'Optional read-only checks included in user approval. No scripts or commands.',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', maxLength: 80 },
                path: { type: 'string', maxLength: 500 },
                kind: {
                  type: 'string',
                  enum: ['file_exists', 'contains_text', 'excludes_text', 'json_equals'],
                },
                text: { type: 'string', maxLength: 2000 },
                pointer: { type: 'string', maxLength: 500 },
                value: {
                  anyOf: [
                    { type: 'string', maxLength: 2000 },
                    { type: 'number' },
                    { type: 'boolean' },
                    { type: 'null' },
                  ],
                },
              },
              required: ['id', 'path', 'kind'],
              additionalProperties: false,
            },
          },
        },
        required: [
          'title',
          'context',
          'decision',
          'alternatives',
          'consequences',
          'constraints',
          'scope',
          'revisitWhen',
        ],
        additionalProperties: false,
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  async execute(input, ctx, opts) {
    (opts?.signal ?? ctx.signal)?.throwIfAborted();
    const store = new ArchitectureDecisionStore(ctx.projectRoot);
    if (input.action === 'list') return store.list();
    if (input.action === 'get') {
      const record = store.get(input.id ?? '');
      if (!record) throw new Error('ADR not found.');
      return record;
    }
    if ((input.action !== 'propose' && input.action !== 'revise') || !input.proposal)
      throw new Error('Use list, get with id, or propose/revise with a complete proposal.');
    const record =
      input.action === 'revise'
        ? store.revise(
            input.id ?? '',
            input.revision ?? 0,
            input.contentHash ?? '',
            input.proposal,
            ctx.agentId || 'agent',
          )
        : store.propose(input.proposal, ctx.agentId || 'agent');
    return {
      record,
      review: `Review ${record.id} in /adr. Status: ${record.status}. Only explicit user review can activate a proposal.`,
    };
  },
};
