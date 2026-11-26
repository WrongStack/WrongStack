import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { AllowAllIntakeAuthorizer } from '../src/authorization.js';
import { RequirementIntakeService } from '../src/service.js';
import { RequirementIntakeStore } from '../src/store.js';
import type { IntakeContext } from '../src/types.js';

it.each(['legacy', 'current'] as const)(
  'withdraws all replaced constraints after a contribution handoff (%s answers)',
  async (format) => {
    const baseDir = await mkdtemp(join(tmpdir(), 'intake-legacy-ownership-'));
    try {
      const store = new RequirementIntakeStore({ baseDir });
      const service = new RequirementIntakeService({
        store,
        authorizer: new AllowAllIntakeAuthorizer(),
      });
      const ctx: IntakeContext = { id: 'editor', type: 'user', projectId: 'project' };
      const { record } = await service.createIntake(
        {
          projectId: ctx.projectId,
          originalRequest: 'Add a reports dashboard.',
          requestedBy: ctx.id,
        },
        ctx,
      );
      await service.addAnswer(record.id, { field: 'constraints', answer: 'offline' }, ctx);
      const answered = await service.addAnswer(
        record.id,
        { field: 'constraints', answer: 'offline, no exports' },
        ctx,
      );
      const [first, second] = answered.answers;
      if (!first || !second) throw new Error('Expected two saved answers');
      if (format === 'legacy') {
        await store.update(record.id, {}, (draft) => {
          for (const answer of draft.answers) delete answer.contributedItems;
        });
      }
      const handoff = await service.updateAnswer(record.id, first.id, { answer: 'mobile' }, ctx);
      expect(handoff.constraints).toEqual(['offline', 'no exports', 'mobile']);

      await service.updateAnswer(record.id, second.id, { answer: 'read-only' }, ctx);
      const saved = await store.load(record.id);
      expect(saved?.constraints).toEqual(['mobile', 'read-only']);
    } finally {
      await rm(baseDir, { recursive: true, force: true });
    }
  },
);
