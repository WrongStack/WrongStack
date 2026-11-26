import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AllowAllIntakeAuthorizer,
  type IntakeContext,
  RequirementIntakeService,
  RequirementIntakeStore,
} from '@wrongstack/requirement-intake';
import { describe, expect, it } from 'vitest';
import { createRequirementIntakeMcpToolHost } from '../src/adapter.js';

describe('requirement_intake_list status filter', () => {
  // F2349: an EMPTY `statuses: []` filter must be refused like every other
  // filter left with no valid status (see the `filterStatuses` doc contract).
  // Before the fix `filterStatuses([])` returned `[]` — an active filter that
  // matches nothing — so the tool answered `{count: 0, isError: false}`, which
  // reads as a real "no matching intakes" answer.
  it('refuses an empty status filter instead of answering it with 0', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'intake-mcp-empty-status-'));
    try {
      const service = new RequirementIntakeService({
        store: new RequirementIntakeStore({ baseDir: dir }),
        authorizer: new AllowAllIntakeAuthorizer(),
      });
      const ctx: IntakeContext = {
        id: 'cursor-agent',
        type: 'automation',
        projectId: 'proj_alpha',
      };
      await service.createIntake(
        { projectId: 'proj_alpha', originalRequest: 'draft me', requestedBy: 'cursor-agent' },
        ctx,
      );

      const host = createRequirementIntakeMcpToolHost('C:/project', {
        dependencies: { service, resolveProjectId: async () => 'proj_alpha' },
      });

      const empty = await host.callTool('requirement_intake_list', { statuses: [] });
      expect(empty.isError, 'statuses:[] must be refused, not answered with 0').toBe(true);

      // Non-vacuous guard: a valid filter still answers normally.
      const valid = await host.callTool('requirement_intake_list', { statuses: ['draft'] });
      expect(valid.isError).toBe(false);
      expect((valid.content as { count: number }).count).toBe(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
