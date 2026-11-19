// @vitest-environment jsdom
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatSteps } from '../src/ChatSteps';
import {
  changedFiles,
  chatSteps,
  outputTail,
  stepSeconds,
  stepsDuration,
} from '../src/chat-steps-model';
import { RunStatusPill } from '../src/RunStatusPill';
import { activityRows } from '../src/session-activity-model';
import { approvalShortcut, ToolApprovalCard } from '../src/ToolApprovalCard';
import { LiveRunActivity } from '../src/TurnTools';
import { renderOpen } from './helpers/render-open';

const call = (id: string, name: string, input: unknown, output = 'ok', durationMs = 100) => [
  { type: 'tool.started', payload: { id, name, input } },
  { type: 'tool.executed', payload: { id, name, ok: true, output, durationMs } },
];
const plan = (status: string) => ({
  todos: [
    { id: '1', content: 'Find the redirect', status: 'completed' },
    { id: '2', content: 'Update the test', status },
  ],
});

describe('conversation steps', () => {
  const events = [
    { type: 'iteration.started', payload: { index: 0 } },
    { type: 'provider.thinking_delta', payload: { text: 'Where is it decided?' } },
    ...call('g', 'grep', { pattern: 'redirect', path: 'src/' }, 'hit', 600),
    ...call('r', 'read', { path: 'tests/login.rs' }, 'body', 200),
    ...call('e', 'edit', { path: 'src/session.rs', old_string: 'a', new_string: 'b\nc' }),
    ...call('t1', 'todo', plan('pending')),
    ...call('t2', 'todo', plan('in_progress')),
    { type: 'iteration.completed', payload: {} },
    { type: 'tool.started', payload: { id: 'b', name: 'bash', input: { command: 'cargo test' } } },
    { type: 'tool.progress', payload: { id: 'b', name: 'bash', event: { text: 'test a ... ok' } } },
    { type: 'run.result', payload: { status: 'done' } },
  ];

  it('leads each call with what it did, keeps one plan card and drops iteration noise', () => {
    const steps = chatSteps(activityRows(events.slice(0, -1)), true);
    expect(steps.map((step) => step.kind)).toEqual([
      'thought',
      'tool',
      'tool',
      'tool',
      'tool',
      'plan',
      'command',
    ]);
    const tools = steps.filter((step) => step.kind === 'tool');
    expect(tools.map((step) => [step.verb, step.target])).toEqual([
      ['searched', '"redirect" in src/'],
      ['read', 'tests/login.rs'],
      ['edited', 'src/session.rs'],
      // An earlier plan update collapses to a line; only the turn's latest plan is a card.
      ['updatedPlan', ''],
    ]);
    expect(tools[2]).toMatchObject({
      added: 2,
      removed: 1,
      diff: { removed: ['a'], added: ['b', 'c'] },
    });
    const card = steps.find((step) => step.kind === 'plan');
    expect(card?.kind === 'plan' && card.items.map((item) => item.status)).toEqual([
      'completed',
      'in_progress',
    ]);
  });

  it('never invents a thinking time and keeps a failed run visible', () => {
    const steps = chatSteps(
      activityRows([
        { type: 'provider.thinking_delta', payload: { text: 'hmm' } },
        ...call('r', 'read', { path: 'a' }),
        { type: 'run.result', payload: { status: 'failed', error: { message: 'boom' } } },
      ]),
      true,
    );
    expect(steps[0]).toEqual({ kind: 'thought', row: expect.anything() });
    expect(steps.at(-1)).toMatchObject({ kind: 'note', row: { status: 'failed' } });
    expect(chatSteps(activityRows(events), false).some((step) => step.kind === 'thought')).toBe(
      false,
    );
  });

  it('measures only reported tool time and formats it briefly', () => {
    expect(stepsDuration(activityRows(events))).toBe(600 + 200 + 100 + 100 + 100);
    expect(stepsDuration(activityRows([{ type: 'tool.started', payload: { id: 'x' } }]))).toBe(
      undefined,
    );
    expect([stepSeconds(612), stepSeconds(12_400), stepSeconds(185_000)]).toEqual([
      '0.6 s',
      '12 s',
      '3 min 05 s',
    ]);
    expect(outputTail(['a\nb\n', 'c\r\nd\n\n'], 3)).toBe('b\nc\nd');
  });

  it('shows the running command with its output only while the turn is live', () => {
    const running = events.slice(0, -1);
    const live = renderOpen(
      createElement(ChatSteps, { events: running, live: true, onOpenFile: () => {} }),
    );
    expect(live).toContain('chat-command');
    expect(live).toContain('test a ... ok');
    expect(live).toContain('chat-step-diff');
    // Reasoning reads as in progress only while it is the newest step of a live turn.
    expect(live).not.toContain('Thinking…');
    const thinking = renderOpen(
      createElement(ChatSteps, { events: events.slice(0, 2), live: true, onOpenFile: () => {} }),
    );
    expect(thinking).toContain('Thinking…');
    const settled = renderOpen(createElement(ChatSteps, { events: running, onOpenFile: () => {} }));
    expect(settled).not.toContain('chat-command');
    expect(settled).not.toContain('chat-step-diff');
    expect(settled).toContain('<strong>Ran</strong>');
    expect(settled).toContain('Thought');
  });
});

describe('approval shortcuts', () => {
  const key = (init: Partial<KeyboardEvent> & { target?: EventTarget | null }) => ({
    key: 'y',
    target: document.body,
    defaultPrevented: false,
    repeat: false,
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...init,
  });
  const card = () => {
    const element = document.createElement('article');
    document.body.append(element);
    // jsdom has no layout; a shown card reports a box.
    element.getClientRects = () => [{}] as unknown as DOMRectList;
    return element;
  };

  it('decides on a bare Y or N pressed outside any field', () => {
    const shown = card();
    expect(approvalShortcut(key({}), shown)).toBe('yes');
    expect(approvalShortcut(key({ key: 'N' }), shown)).toBe('no');
    shown.remove();
  });

  it('ignores typing, modifiers, repeats, hidden cards and open dialogs', () => {
    const shown = card();
    const field = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.append(field, editable);
    expect(approvalShortcut(key({ target: field }), shown)).toBeNull();
    expect(approvalShortcut(key({ target: editable }), shown)).toBeNull();
    expect(approvalShortcut(key({ ctrlKey: true }), shown)).toBeNull();
    expect(approvalShortcut(key({ shiftKey: true }), shown)).toBeNull();
    expect(approvalShortcut(key({ repeat: true }), shown)).toBeNull();
    expect(approvalShortcut(key({ isComposing: true }), shown)).toBeNull();
    expect(approvalShortcut(key({ key: 'a' }), shown)).toBeNull();
    const hidden = document.createElement('article');
    document.body.append(hidden);
    expect(approvalShortcut(key({}), hidden)).toBeNull();
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    document.body.append(dialog);
    expect(approvalShortcut(key({}), shown)).toBeNull();
    for (const element of [shown, field, editable, hidden, dialog]) element.remove();
  });

  it('decides nothing while two conversations each show a card that listens', () => {
    const one = card();
    const two = card();
    one.setAttribute('data-approval-shortcuts', '');
    expect(approvalShortcut(key({}), one)).toBe('yes');
    two.setAttribute('data-approval-shortcuts', '');
    expect(approvalShortcut(key({}), one)).toBeNull();
    expect(approvalShortcut(key({}), two)).toBeNull();
    one.remove();
    two.remove();
  });
});

describe('the approval banner', () => {
  const banner = (approval: Record<string, unknown>) => {
    const html = renderToStaticMarkup(
      createElement(ToolApprovalCard, { approval, send: async () => {}, connected: true }),
    );
    // What is visible without opening Details.
    return { html, banner: html.slice(0, html.indexOf('<details')) };
  };

  it('shows an exec call with every argument, never only the executable', () => {
    const { banner: shown } = banner({
      id: 'a',
      toolName: 'exec',
      input: { command: 'git', args: ['push', '--force', 'origin', 'main'] },
    });
    expect(shown).toContain('git push --force origin main');
    expect(shown).toContain('approval-banner-subject command');
  });

  it('keeps the arguments of an unfamiliar or destructive call open', () => {
    const generic = banner({ id: 'b', toolName: 'mcp_deploy', input: { target: 'prod' } }).html;
    expect(generic).toContain('<details class="approval-details" open=""');
    const bash = banner({ id: 'c', toolName: 'bash', input: { command: 'ls' } }).html;
    expect(bash).toContain('<details class="approval-details">');
    const destructive = banner({
      id: 'd',
      toolName: 'bash',
      riskTier: 'destructive',
      input: { command: 'rm -rf build' },
    }).html;
    expect(destructive).toContain('<details class="approval-details" open=""');
  });
});

describe('a finished turn’s changed files', () => {
  const edit = (id: string, path: string, ok = true) => [
    {
      type: 'tool.started',
      payload: { id, name: 'edit', input: { path, old_string: 'a', new_string: 'b\nc' } },
    },
    { type: 'tool.executed', payload: { id, name: 'edit', ok } },
  ];

  it('sums each file’s lines across its edits and leaves failed edits out', () => {
    const rows = activityRows([
      ...edit('1', 'src/a.ts'),
      ...edit('2', 'src/b.ts', false),
      ...edit('3', 'src/a.ts'),
      ...call('w', 'write', { path: 'docs/new.md', content: 'x\ny\nz' }),
      ...call('r', 'read', { path: 'src/c.ts' }),
    ]);
    expect(changedFiles(rows)).toEqual([
      { path: 'src/a.ts', added: 4, removed: 2 },
      { path: 'docs/new.md', added: 3, removed: 0 },
    ]);
  });

  it('summarises them under the turn with a way to review them', () => {
    const html = renderOpen(
      createElement(LiveRunActivity, {
        events: [...edit('1', 'src/deep/a.ts'), ...edit('2', 'src/b.ts')],
        live: false,
        onOpenFile: () => {},
        onReviewChanges: () => {},
      }),
    );
    expect(html).toContain('2 files changed');
    expect(html).toContain('title="src/deep/a.ts">a.ts</button>');
    expect(html).toContain('Review changes');
    const live = renderOpen(
      createElement(LiveRunActivity, { events: edit('1', 'src/a.ts'), onOpenFile: () => {} }),
    );
    expect(live).not.toContain('chat-turn-changes');
  });

  it('says how long a turn has run in one short unit', () => {
    const pill = (ago: number) =>
      renderToStaticMarkup(
        createElement(RunStatusPill, {
          tone: 'working',
          label: 'Working',
          since: Date.now() - ago,
        }),
      );
    expect(pill(42_000)).toContain('· 42 s');
    expect(pill(725_000)).toContain('· 12 min');
    expect(pill(3_900_000)).toContain('· 1 h 05 min');
    expect(
      renderToStaticMarkup(
        createElement(RunStatusPill, { tone: 'ready', label: 'Ready', since: null }),
      ),
    ).not.toContain('·');
  });
});
