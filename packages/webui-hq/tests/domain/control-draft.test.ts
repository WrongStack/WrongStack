/**
 * The Control plane's guardrails.
 *
 * Three things must never drift: which types are destructive (and therefore
 * demand a typed confirmation), what stops a draft from being dispatchable,
 * and the exact payload each type sends. The last one matters because the
 * receiving client dispatches on those field names.
 */
import { describe, expect, it } from 'vitest';
import {
  buildControlDraft,
  confirmWordFor,
  type ControlFormState,
} from '../../src/domain/control-draft.js';

function form(overrides: Partial<ControlFormState> = {}): ControlFormState {
  return {
    type: 'steer',
    steerTo: '',
    steerSubject: '',
    steerBody: '',
    spawnRole: 'bug-hunter',
    spawnTask: '',
    abortTarget: 'leader',
    broadcastSubject: '',
    broadcastBody: '',
    runCommand: '',
    runCwd: '',
    ...overrides,
  };
}

describe('confirmWordFor', () => {
  it('demands a typed word for the two destructive types', () => {
    expect(confirmWordFor('abort')).toBe('ABORT');
    expect(confirmWordFor('run-command')).toBe('RUN');
  });

  it.each(['steer', 'btw', 'queue', 'spawn', 'broadcast'] as const)(
    'asks for nothing on %s',
    (type) => {
      expect(confirmWordFor(type)).toBeNull();
    },
  );
});

describe('buildControlDraft — message types', () => {
  it('defaults the recipient to the leader', () => {
    const draft = buildControlDraft(form({ steerBody: 'go' }));
    expect(draft.payload.to).toBe('leader');
    expect(draft.summary).toContain('leader');
  });

  it('only a steer carries high priority', () => {
    expect(buildControlDraft(form({ type: 'steer', steerBody: 'x' })).payload.priority).toBe(
      'high',
    );
    expect(buildControlDraft(form({ type: 'btw', steerBody: 'x' })).payload.priority).toBe('normal');
    expect(buildControlDraft(form({ type: 'queue', steerBody: 'x' })).payload.priority).toBe(
      'normal',
    );
  });

  it('defaults the subject per type', () => {
    expect(buildControlDraft(form({ type: 'btw', steerBody: 'x' })).payload.subject).toBe('HQ btw');
  });

  it.each(['steer', 'btw', 'queue'] as const)('%s needs a body', (type) => {
    expect(buildControlDraft(form({ type })).disabledReason).toBe('Message body is required.');
    expect(buildControlDraft(form({ type, steerBody: '  ' })).disabledReason).not.toBeNull();
    expect(buildControlDraft(form({ type, steerBody: 'go' })).disabledReason).toBeNull();
  });

  it.each(['steer', 'btw', 'queue'] as const)('%s is not destructive', (type) => {
    expect(buildControlDraft(form({ type, steerBody: 'x' })).risk).toBe('normal');
  });
});

describe('buildControlDraft — abort', () => {
  it('is destructive even though nothing has to be filled in', () => {
    const draft = buildControlDraft(form({ type: 'abort' }));
    expect(draft.risk).toBe('danger');
    // Nothing to complete, which is exactly why the typed confirmation is the
    // only thing standing between a click and a stopped fleet.
    expect(draft.disabledReason).toBeNull();
  });

  it('distinguishes the leader from the whole fleet', () => {
    expect(buildControlDraft(form({ type: 'abort', abortTarget: 'leader' })).payload).toEqual({
      target: 'leader',
    });
    const fleet = buildControlDraft(form({ type: 'abort', abortTarget: 'fleet' }));
    expect(fleet.payload).toEqual({ target: 'fleet' });
    expect(fleet.summary).toContain('every subagent');
  });
});

describe('buildControlDraft — run-command', () => {
  it('is destructive and needs a command', () => {
    const empty = buildControlDraft(form({ type: 'run-command' }));
    expect(empty.risk).toBe('danger');
    expect(empty.disabledReason).toBe('Command is required.');
  });

  it('omits cwd entirely rather than sending an empty one', () => {
    expect(buildControlDraft(form({ type: 'run-command', runCommand: 'pnpm test' })).payload).toEqual(
      { command: 'pnpm test' },
    );
    expect(
      buildControlDraft(form({ type: 'run-command', runCommand: 'pnpm test', runCwd: '  ' }))
        .payload,
    ).toEqual({ command: 'pnpm test' });
  });

  it('passes a real cwd through, trimmed', () => {
    expect(
      buildControlDraft(form({ type: 'run-command', runCommand: 'ls', runCwd: ' /srv ' })).payload,
    ).toEqual({ command: 'ls', cwd: '/srv' });
  });
});

describe('buildControlDraft — spawn', () => {
  it('needs a role', () => {
    expect(buildControlDraft(form({ type: 'spawn', spawnRole: ' ' })).disabledReason).toBe(
      'Role is required.',
    );
  });

  it('omits an empty task', () => {
    expect(buildControlDraft(form({ type: 'spawn' })).payload).toEqual({ role: 'bug-hunter' });
  });

  it('includes a trimmed task and says so', () => {
    const draft = buildControlDraft(form({ type: 'spawn', spawnTask: '  find the leak  ' }));
    expect(draft.payload).toEqual({ role: 'bug-hunter', task: 'find the leak' });
    expect(draft.summary).toContain('initial task');
  });
});

describe('buildControlDraft — broadcast', () => {
  it('needs a body and defaults the subject', () => {
    expect(buildControlDraft(form({ type: 'broadcast' })).disabledReason).toBe(
      'Broadcast body is required.',
    );
    const draft = buildControlDraft(form({ type: 'broadcast', broadcastBody: 'ship it' }));
    expect(draft.payload).toEqual({
      subject: 'HQ broadcast',
      body: 'ship it',
      priority: 'normal',
    });
    expect(draft.risk).toBe('normal');
  });
});
