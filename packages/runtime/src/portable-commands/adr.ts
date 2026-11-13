import { createHash } from 'node:crypto';
import type { SlashCommand } from '@wrongstack/contracts/types';
import {
  type ArchitectureDecisionContent,
  type ArchitectureDecisionReview,
  ArchitectureDecisionStore,
  architectureDecisionReadAuthorizer,
  checkArchitectureDecisions,
  formatArchitectureDecision,
  formatArchitectureDecisionTransfer,
  parseArchitectureDecisionTransfer,
} from '@wrongstack/core/storage';

const HELP = [
  '/adr — project Architecture Decision Records',
  '/adr list | show <id> | history <id>',
  '/adr revision <id> <revision> — inspect an immutable historical snapshot',
  '/adr check [id] — evaluate declared checks on accepted decisions',
  '/adr propose <JSON: title,context,decision,alternatives,consequences,constraints,scope,revisitWhen,supersedes?>',
  '/adr accept|reject|deprecate <id> <revision> <contentHash> <reason>',
  '/adr revise <JSON: id,revision,contentHash,proposal> — update a pending proposal',
  '/adr export <id> — return Markdown for saving in docs/adr/',
  '/adr export-json <id> — portable proposal JSON without approvals or project links',
  '/adr import <portable JSON> — save transferred content for a separate local review',
  'Review commands act on the exact displayed revision. Only accepted records guide agents.',
  'To change an accepted decision, propose a replacement with supersedes set to its id.',
].join('\n');

/** User command surface shared by terminal, WebUI and desktop. Never a model tool. */
export function buildAdrCommand(host: {
  readonly projectRoot: string;
  permissionPolicy?: Parameters<typeof architectureDecisionReadAuthorizer>[1];
  toolRegistry?:
    | { get(name: string): import('@wrongstack/contracts/types').Tool | undefined }
    | undefined;
}): SlashCommand {
  return {
    name: 'adr',
    category: 'Inspect',
    description: 'Review and manage persistent project architecture decisions',
    argsHint:
      '[list|show|propose|accept|reject|deprecate|history|revision|export|export-json|import|check]',
    help: HELP,
    async run(args, ctx) {
      const store = new ArchitectureDecisionStore(host.projectRoot);
      const [verb = '', ...rest] = args.trim().split(/\s+/);
      if (verb === 'help') return { message: HELP };
      if (verb === 'import' || verb === 'preview-import') {
        const proposal = parseArchitectureDecisionTransfer(args.trim().slice(verb.length).trim());
        if (verb === 'preview-import') return { message: JSON.stringify(proposal) };
        return { message: formatArchitectureDecision(store.propose(proposal, 'user:import')) };
      }
      if (verb === 'summary-json') {
        const records = store.list();
        return {
          message: JSON.stringify({
            projectId: store.projectId,
            pending: records.filter((record) => record.status === 'proposed').length,
            total: records.length,
            version: createHash('sha256')
              .update(
                JSON.stringify(
                  records.map(({ id, revision, status, contentHash }) => [
                    id,
                    revision,
                    status,
                    contentHash,
                  ]),
                ),
              )
              .digest('hex'),
          }),
        };
      }
      if (verb === 'check' || verb === 'check-json') {
        const report = await checkArchitectureDecisions(
          host.projectRoot,
          architectureDecisionReadAuthorizer(
            ctx,
            host.permissionPolicy,
            host.toolRegistry?.get('read'),
          ),
          rest[0],
        );
        return {
          message:
            verb === 'check-json'
              ? JSON.stringify(report)
              : `ADR compliance: ${report.status}\n${report.results.map((result) => `${result.decisionId} | ${result.checkId} | ${result.status} | ${result.path}: ${result.message}`).join('\n')}`,
        };
      }
      if (!verb || verb === 'list' || verb === 'list-json') {
        const records = store
          .list()
          .sort(
            (a, b) =>
              Number(b.status === 'proposed') - Number(a.status === 'proposed') ||
              b.updatedAt.localeCompare(a.updatedAt),
          );
        if (verb === 'list-json') {
          const offset = Number(rest[0] ?? 0);
          if (!Number.isSafeInteger(offset) || offset < 0)
            throw new Error('Invalid ADR page offset.');
          return {
            message: JSON.stringify({
              total: records.length,
              records: records
                .slice(offset, offset + 50)
                .map(({ id, title, status, revision, contentHash, updatedAt }) => ({
                  id,
                  title,
                  status,
                  revision,
                  contentHash,
                  updatedAt,
                })),
              nextOffset: offset + 50 < records.length ? offset + 50 : null,
            }),
          };
        }
        return {
          message: records.length
            ? records
                .map(
                  (record) =>
                    `${record.id} | ${record.status} | r${record.revision} | ${record.title}`,
                )
                .join('\n') + '\n\n/adr show <id> to inspect and review.'
            : 'No architecture decisions yet. Use architecture_decisions to propose a significant choice, or /adr propose <JSON>.',
        };
      }
      if (verb === 'propose') {
        const proposal = JSON.parse(
          args.trim().slice(verb.length).trim(),
        ) as ArchitectureDecisionContent;
        const record = store.propose(proposal, 'user');
        return { message: formatArchitectureDecision(record) };
      }
      if (verb === 'revise') {
        const input = JSON.parse(args.trim().slice(verb.length).trim()) as {
          id: string;
          revision: number;
          contentHash: string;
          proposal: ArchitectureDecisionContent;
        };
        return {
          message: formatArchitectureDecision(
            store.revise(input.id, input.revision, input.contentHash, input.proposal, 'user'),
          ),
        };
      }
      if (verb === 'review') {
        const review = JSON.parse(
          args.trim().slice(verb.length).trim(),
        ) as ArchitectureDecisionReview;
        return {
          message: formatArchitectureDecision(
            store.review(review, `user:${ctx?.session?.id ?? 'interactive'}`),
          ),
        };
      }
      const record = store.get(rest[0] ?? '');
      if (!record) throw new Error('ADR not found. Use /adr list.');
      if (verb === 'show' || verb === 'export')
        return { message: formatArchitectureDecision(record) };
      if (verb === 'export-json') return { message: formatArchitectureDecisionTransfer(record) };
      if (verb === 'show-json') return { message: JSON.stringify(record) };
      if (verb === 'revision' || verb === 'revision-json') {
        const historical = store.getRevision(record.id, Number(rest[1]));
        if (!historical) throw new Error('ADR revision not found.');
        return {
          message:
            verb === 'revision-json'
              ? JSON.stringify(historical)
              : formatArchitectureDecision(historical),
        };
      }
      if (verb === 'history-json') {
        const page = store.historyPage(
          record.id,
          rest[1] === undefined ? undefined : Number(rest[1]),
        );
        return {
          message: JSON.stringify({
            projectId: store.projectId,
            decisionId: record.id,
            nextBeforeRevision: page.nextBeforeRevision,
            records: page.records.map(
              ({ revision, status, updatedAt, contentHash, proposedBy, resolvedBy }) => ({
                revision,
                status,
                updatedAt,
                contentHash,
                proposedBy,
                ...(resolvedBy ? { resolvedBy } : {}),
              }),
            ),
          }),
        };
      }
      if (verb === 'history')
        return {
          message: store
            .history(record.id)
            .map(
              (entry) =>
                `r${entry.revision} | ${entry.status} | ${entry.updatedAt} | ${entry.resolvedBy ?? entry.proposedBy} | ${entry.resolutionReason ?? ''}`,
            )
            .join('\n'),
        };
      if (verb === 'accept' || verb === 'reject' || verb === 'deprecate') {
        const revision = Number(rest[1]);
        const contentHash = rest[2] ?? '';
        if (!Number.isSafeInteger(revision) || revision < 1 || !/^[a-f0-9]{64}$/.test(contentHash))
          throw new Error(
            `Usage: /adr ${verb} <id> <revision> <contentHash> <reason>. Copy revision and hash from /adr show.`,
          );
        const reviewed = store.review(
          {
            projectId: store.projectId,
            id: record.id,
            revision,
            contentHash,
            action: verb,
            reason: rest.slice(3).join(' '),
          },
          `user:${ctx?.session?.id ?? 'interactive'}`,
        );
        return { message: formatArchitectureDecision(reviewed) };
      }
      throw new Error(HELP);
    },
  };
}
