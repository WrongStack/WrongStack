/**
 * `/intake [text]` — create and submit a requirement intake record from the
 * current prompt.
 *
 * With no arguments it uses the most recent user prompt in the live session;
 * with text it uses that verbatim. The exact text becomes the record's
 * immutable `originalRequest`. Records are stored under the project's
 * `.wrongstack` state dir (`~/.wrongstack/projects/<slug>/requirement-intakes`)
 * and are ready for downstream modules (SDD interview kickoff, planning).
 */

import type { SlashCommand } from '@wrongstack/core/types';
import { ensureProjectIdentity, resolveWstackPaths } from '@wrongstack/core/utils';
import {
  AllowAllIntakeAuthorizer,
  RequirementIntakeService,
  RequirementIntakeStore,
} from '@wrongstack/requirement-intake';
import type { SlashCommandContext } from './command-context.js';

const INTAKE_ACTOR = { id: 'cli-operator', type: 'user' } as const;

/** Most recent user message with plain-text content, or '' when none. */
function lastUserPrompt(opts: SlashCommandContext): string {
  const ctx = opts.context;
  if (!ctx) return '';
  for (let index = ctx.messages.length - 1; index >= 0; index -= 1) {
    const message = ctx.messages[index];
    if (message?.role === 'user' && typeof message.content === 'string') {
      const trimmed = message.content.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return '';
}

export function buildIntakeCommand(opts: SlashCommandContext): SlashCommand {
  return {
    name: 'intake',
    category: 'Run',
    description:
      'Create and submit a requirement intake record from the current prompt (or given text)',
    argsHint: '[request text]',
    help: [
      '/intake [text]   Create + submit a requirement intake record.',
      '                 No text → uses the most recent prompt in this session.',
      '',
      "The exact text is preserved verbatim as the record's original request;",
      'the record is stored under the project state dir and is ready for',
      'downstream modules (SDD interview kickoff, planning).',
    ].join('\n'),
    async run(args) {
      const text = args.trim() || lastUserPrompt(opts);
      if (!text) {
        return {
          message:
            'Nothing to intake — give the request as text or submit a prompt first.\nUsage: /intake <request text>',
        };
      }

      const identity = await ensureProjectIdentity(opts.projectRoot);
      const projectId = identity.identity.projectId;
      const baseDir =
        opts.paths?.projectRequirementIntakes ??
        resolveWstackPaths({ projectRoot: opts.projectRoot }).projectRequirementIntakes;

      const service = new RequirementIntakeService({
        store: new RequirementIntakeStore({ baseDir }),
        authorizer: new AllowAllIntakeAuthorizer(),
      });
      const ctx = { ...INTAKE_ACTOR, projectId };

      const { record, created, idempotent } = await service.createIntake(
        { projectId, originalRequest: text, requestedBy: ctx.id },
        ctx,
      );
      const { record: submitted } = await service.submitIntake(record.id, ctx);

      return {
        message: [
          idempotent
            ? '⚠ Already recorded — resubmitted the existing record:'
            : '📥 Requirement intake recorded:',
          `  id: ${submitted.id}`,
          `  title: ${submitted.title}`,
          `  type: ${submitted.requestType}`,
          `  status: ${submitted.status} (${created ? 'new' : 'existing'})`,
          `  stored: ${baseDir}`,
          '',
          'Use /sdd to turn this into a specification. Records live under the',
          'project state dir (see `stored` above) and are consumed by the',
          'WebUI requirement-intake API.',
        ].join('\n'),
      };
    },
  };
}
