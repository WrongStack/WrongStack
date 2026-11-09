import { createAutomationJobInput } from '@wrongstack/webui-protocol';
import { describe, expect, it } from 'vitest';
import {
  automationDraftCodec,
  automationDraftKey,
  jobDrafts,
  NEW_AUTOMATION,
  projectAutomationDrafts,
} from '../src/automation-draft';

const input = { ...createAutomationJobInput(), name: 'Nightly checks', enabled: false };
const record = { ...input, id: 'job-1', revision: 3 } as never;

describe('automation draft envelope', () => {
  it('projects only this project’s in-window drafts and round-trips them', () => {
    const project = crypto.randomUUID(),
      other = crypto.randomUUID();
    expect(projectAutomationDrafts(project, undefined)).toBeNull();
    jobDrafts.set(automationDraftKey(project), { selected: null, draft: input, commands: '' });
    jobDrafts.set(automationDraftKey(project, 'job-1'), {
      selected: record,
      draft: { ...input, prompt: 'Edited' },
      commands: 'bun run test',
    });
    jobDrafts.set(automationDraftKey(other), { selected: null, draft: input, commands: 'x' });
    const saved = projectAutomationDrafts(project, 'job-1')!;
    expect(saved.active).toBe('job-1');
    expect(Object.keys(saved.drafts).sort()).toEqual([NEW_AUTOMATION, 'job-1']);
    expect(automationDraftCodec.parse(automationDraftCodec.serialize(saved))).toEqual(saved);
    // The projection is a copy: later edits in the window do not mutate the saved value.
    jobDrafts.get(automationDraftKey(project, 'job-1'))!.commands = 'changed';
    expect(saved.drafts['job-1']?.commands).toBe('bun run test');
    for (const id of [project, other]) {
      jobDrafts.delete(automationDraftKey(id));
      jobDrafts.delete(automationDraftKey(id, 'job-1'));
    }
  });
  it('refuses foreign, mismatched or oversized envelopes', () => {
    const draft = { selected: null, draft: input, commands: '' };
    expect(automationDraftCodec.parse(null)).toBeNull();
    for (const value of [
      { version: 2, active: NEW_AUTOMATION, drafts: { [NEW_AUTOMATION]: draft } },
      { version: 1, active: NEW_AUTOMATION, drafts: [] },
      { version: 1, active: 1, drafts: {} },
      { version: 1, active: '', drafts: { [NEW_AUTOMATION]: draft } },
      { version: 1, active: '__proto__', drafts: { [NEW_AUTOMATION]: draft } },
      // A job draft must be stored under its own job id; a new draft has no saved record.
      { version: 1, active: 'job-2', drafts: { 'job-2': { ...draft, selected: record } } },
      {
        version: 1,
        active: NEW_AUTOMATION,
        drafts: { [NEW_AUTOMATION]: { ...draft, selected: record } },
      },
      {
        version: 1,
        active: NEW_AUTOMATION,
        drafts: { [NEW_AUTOMATION]: { ...draft, commands: 3 } },
      },
      {
        version: 1,
        active: NEW_AUTOMATION,
        drafts: { [NEW_AUTOMATION]: { ...draft, draft: null } },
      },
      {
        version: 1,
        active: 'x',
        drafts: JSON.parse('{"__proto__":{"selected":null,"draft":{},"commands":""}}'),
      },
      {
        version: 1,
        active: NEW_AUTOMATION,
        drafts: { [NEW_AUTOMATION]: { ...draft, commands: 'c'.repeat(1_000_001) } },
      },
      {
        version: 1,
        active: NEW_AUTOMATION,
        drafts: Object.fromEntries(
          Array.from({ length: 51 }, (_, index) => [
            `job-${index}`,
            { ...draft, selected: { id: `job-${index}` } },
          ]),
        ),
      },
    ])
      expect(() => automationDraftCodec.parse(value)).toThrow(/unsupported format/);
  });
});
