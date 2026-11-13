import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArchitectureDecisionsPanel } from '../../src/components/ArchitectureDecisionsPanel.js';

const fixture = vi.hoisted(() => ({ rpc: vi.fn(), projectRoot: 'project-a' }));
vi.mock('@/lib/portable-command-rpc', () => ({ invokePortableCommand: fixture.rpc }));
vi.mock('@/stores', () => ({
  useSessionStore: (selector: (s: unknown) => unknown) =>
    selector({ projectRoot: fixture.projectRoot }),
}));
vi.mock('@/i18n', () => ({ useAppTranslation: () => ({ t: (key: string) => key }) }));
const record = {
  projectId: 'project-a',
  id: 'ADR-fixture',
  title: 'Provider boundary',
  revision: 3,
  contentHash: 'a'.repeat(64),
  status: 'proposed',
  context: 'Keep core independent.',
  decision: 'Use a provider port.',
  alternatives: ['Direct imports'],
  consequences: ['Explicit contracts'],
  constraints: ['No provider imports'],
  scope: [],
  revisitWhen: '',
  proposedBy: 'agent',
  createdAt: '',
  updatedAt: '',
};
const page = { message: JSON.stringify({ records: [record], total: 1, nextOffset: null }) };

beforeEach(() => {
  fixture.projectRoot = 'project-a';
  fixture.rpc.mockReset();
  fixture.rpc.mockImplementation(async (_name: string, args: string) =>
    args.startsWith('list-json') ? page : { message: JSON.stringify(record) },
  );
});
afterEach(cleanup);

describe('architecture decision review panel', () => {
  it('starts a replacement of an accepted decision as a separate proposal with its checks', async () => {
    const accepted = {
      ...record,
      status: 'accepted',
      checks: [{ id: 'port', kind: 'file_exists', path: 'port.ts' }],
    };
    fixture.rpc.mockImplementation(async (_name: string, args: string) =>
      args.startsWith('list-json') ? page : { message: JSON.stringify(accepted) },
    );
    render(<ArchitectureDecisionsPanel sessionId="conversation-a" />);
    fireEvent.click(await screen.findByRole('button', { name: /Provider boundary/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'activity:adr.replace' }));
    expect(
      (screen.getByLabelText('activity:adr.fields.supersedes') as HTMLTextAreaElement).value,
    ).toBe(record.id);
    expect(screen.getByLabelText('activity:adr.checks.path')).toHaveProperty('value', 'port.ts');
    expect(fixture.rpc.mock.calls.some(([, args]) => /^(propose|review) /.test(args))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'activity:adr.saveProposal' }));
    await waitFor(() =>
      expect(fixture.rpc.mock.calls.some(([, args]) => args.startsWith('propose '))).toBe(true),
    );
    const [, args] = fixture.rpc.mock.calls.find(([, args]) => args.startsWith('propose '))!;
    expect(JSON.parse(args.slice(8))).toMatchObject({
      supersedes: record.id,
      checks: accepted.checks,
    });
    expect(fixture.rpc.mock.calls.some(([, args]) => args.startsWith('review '))).toBe(false);
  });
  it('rejects an oversized transfer before reading it or invoking the engine', async () => {
    render(<ArchitectureDecisionsPanel sessionId="conversation-a" />);
    await screen.findByRole('button', { name: /Provider boundary/ });
    const file = new File(['{}'], 'large.json');
    Object.defineProperty(file, 'size', { value: 128 * 1024 + 1 });
    const read = vi.fn();
    Object.defineProperty(file, 'arrayBuffer', { value: read });
    fireEvent.change(screen.getByLabelText('activity:adr.importFile'), {
      target: { files: [file] },
    });
    expect((await screen.findByRole('alert')).textContent).toContain('activity:adr.importTooLarge');
    expect(read).not.toHaveBeenCalled();
    expect(fixture.rpc.mock.calls.some(([, args]) => args.startsWith('preview-import'))).toBe(
      false,
    );
  });

  it('does not send a delayed import to a different project after switching', async () => {
    const view = render(<ArchitectureDecisionsPanel sessionId="conversation-a" />);
    await screen.findByRole('button', { name: /Provider boundary/ });
    let resolve!: (bytes: ArrayBuffer) => void;
    const file = new File(['{}'], 'decision.json');
    Object.defineProperty(file, 'arrayBuffer', {
      value: () =>
        new Promise<ArrayBuffer>((done) => {
          resolve = done;
        }),
    });
    fireEvent.change(screen.getByLabelText('activity:adr.importFile'), {
      target: { files: [file] },
    });
    fixture.projectRoot = 'project-b';
    view.rerender(<ArchitectureDecisionsPanel sessionId="conversation-b" />);
    await act(async () => resolve(new TextEncoder().encode('{}').buffer));
    expect(fixture.rpc.mock.calls.some(([, args]) => args.startsWith('preview-import'))).toBe(
      false,
    );
    expect(screen.queryByLabelText('activity:adr.fields.title')).toBeNull();
  });

  it('shows engine validation failures without creating a draft', async () => {
    fixture.rpc.mockImplementation(async (_name: string, args: string) =>
      args.startsWith('preview-import')
        ? { error: 'ADR transfer format or version is unsupported.' }
        : page,
    );
    render(<ArchitectureDecisionsPanel sessionId="conversation-a" />);
    await screen.findByRole('button', { name: /Provider boundary/ });
    const file = new File(['{}'], 'decision.json');
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new TextEncoder().encode('{}').buffer,
    });
    fireEvent.change(screen.getByLabelText('activity:adr.importFile'), {
      target: { files: [file] },
    });
    expect((await screen.findByRole('alert')).textContent).toContain('unsupported');
    expect(screen.queryByLabelText('activity:adr.fields.title')).toBeNull();
  });

  it('previews an imported file as an editable draft without saving or accepting it', async () => {
    fixture.rpc.mockImplementation(async (_name: string, args: string) =>
      args.startsWith('list-json') ? page : { message: JSON.stringify(record) },
    );
    render(<ArchitectureDecisionsPanel sessionId="conversation-a" />);
    await screen.findByRole('button', { name: /Provider boundary/ });
    const file = new File(['{}'], 'decision.json', { type: 'application/json' });
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new TextEncoder().encode('{}').buffer,
    });
    fireEvent.change(screen.getByLabelText('activity:adr.importFile'), {
      target: { files: [file] },
    });
    const title = (await screen.findByLabelText(
      'activity:adr.fields.title',
    )) as HTMLTextAreaElement;
    expect(title.value).toBe(record.title);
    expect(fixture.rpc).toHaveBeenCalledWith('adr', 'preview-import {}', {
      sessionId: 'conversation-a',
    });
    expect(fixture.rpc.mock.calls.some(([, args]) => /^(propose|import|review) /.test(args))).toBe(
      false,
    );
  });

  it('refreshes new agent proposals without discarding a draft', async () => {
    let version = 'a';
    let rows = [record];
    fixture.rpc.mockImplementation(async (_name: string, args: string) =>
      args === 'summary-json'
        ? {
            message: JSON.stringify({
              projectId: 'project-a',
              pending: rows.length,
              total: rows.length,
              version: version.repeat(64),
            }),
          }
        : args.startsWith('list-json')
          ? { message: JSON.stringify({ records: rows, total: rows.length, nextOffset: null }) }
          : { message: JSON.stringify(record) },
    );
    render(<ArchitectureDecisionsPanel sessionId="conversation-a" />);
    await screen.findByRole('button', { name: /Provider boundary/ });
    fireEvent.click(screen.getByRole('button', { name: 'activity:adr.new' }));
    fireEvent.change(screen.getByLabelText('activity:adr.fields.title'), {
      target: { value: 'My unfinished draft' },
    });
    version = 'b';
    rows = [record, { ...record, id: 'ADR-worker', title: 'Worker proposal' }];
    fireEvent(window, new Event('focus'));
    expect(await screen.findByRole('button', { name: /Worker proposal/ })).toBeTruthy();
    expect((screen.getByLabelText('activity:adr.fields.title') as HTMLTextAreaElement).value).toBe(
      'My unfinished draft',
    );
    expect(fixture.rpc.mock.calls.some(([, args]) => args.startsWith('review '))).toBe(false);
  });

  it('keeps the displayed review intact and requires reloading a changed revision', async () => {
    let current = record;
    fixture.rpc.mockImplementation(async (_name: string, args: string) =>
      args === 'summary-json'
        ? {
            message: JSON.stringify({
              projectId: 'project-a',
              pending: 1,
              total: 1,
              version: (current.revision === 3 ? 'a' : 'b').repeat(64),
            }),
          }
        : args.startsWith('list-json')
          ? { message: JSON.stringify({ records: [current], total: 1, nextOffset: null }) }
          : { message: JSON.stringify(current) },
    );
    render(<ArchitectureDecisionsPanel sessionId="conversation-a" />);
    fireEvent.click(await screen.findByRole('button', { name: /Provider boundary/ }));
    const reason = (await screen.findByLabelText('activity:adr.reason')) as HTMLTextAreaElement;
    fireEvent.change(reason, { target: { value: 'Reviewing the displayed content' } });
    current = {
      ...record,
      revision: 4,
      decision: 'A changed decision',
      contentHash: 'b'.repeat(64),
    };
    fireEvent(window, new Event('focus'));
    await screen.findByText('activity:adr.staleReview');
    expect(reason.value).toBe('Reviewing the displayed content');
    expect(screen.queryByText('A changed decision')).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'activity:adr.accept' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'activity:adr.reloadDecision' }));
    await screen.findByText('A changed decision');
    expect((screen.getByLabelText('activity:adr.reason') as HTMLTextAreaElement).value).toBe('');
  });

  it('lets a numeric JSON expectation be cleared without silently changing it to zero', async () => {
    const numeric = {
      ...record,
      checks: [{ id: 'number', kind: 'json_equals', path: 'a.json', pointer: '/n', value: -1 }],
    };
    fixture.rpc.mockImplementation(async (_name: string, args: string) =>
      args.startsWith('list-json') ? page : { message: JSON.stringify(numeric) },
    );
    render(<ArchitectureDecisionsPanel sessionId="conversation-a" />);
    fireEvent.click(await screen.findByRole('button', { name: /Provider boundary/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'activity:adr.edit' }));
    const input = screen.getByLabelText('activity:adr.checks.value') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '' } });
    expect(input.value).toBe('');
    expect(input.checkValidity()).toBe(false);
    fireEvent.change(input, { target: { value: '-1.5' } });
    fireEvent.click(screen.getByRole('button', { name: 'activity:adr.saveProposal' }));
    await waitFor(() =>
      expect(fixture.rpc.mock.calls.some(([, args]) => args.startsWith('revise '))).toBe(true),
    );
    const [, args] = fixture.rpc.mock.calls.find(([, value]) => value.startsWith('revise '))!;
    expect(JSON.parse(args.slice(7)).proposal.checks[0].value).toBe(-1.5);
  });
  it('adds a scalar JSON check through accessible form controls', async () => {
    render(<ArchitectureDecisionsPanel sessionId="conversation-a" />);
    await screen.findByRole('button', { name: /Provider boundary/ });
    fireEvent.click(screen.getByRole('button', { name: 'activity:adr.new' }));
    for (const [key, value] of Object.entries({
      title: 'Manifest',
      context: 'Package identity.',
      decision: 'Keep package name.',
    }))
      fireEvent.change(screen.getByLabelText(`activity:adr.fields.${key}`), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'activity:adr.checks.add' }));
    fireEvent.change(screen.getByLabelText('activity:adr.checks.path'), {
      target: { value: 'package.json' },
    });
    fireEvent.change(screen.getByLabelText('activity:adr.checks.kind', { exact: true }), {
      target: { value: 'json_equals' },
    });
    fireEvent.change(screen.getByLabelText('activity:adr.checks.pointer'), {
      target: { value: '/name' },
    });
    fireEvent.change(screen.getByLabelText('activity:adr.checks.value'), {
      target: { value: 'demo' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'activity:adr.saveProposal' }));
    await waitFor(() =>
      expect(fixture.rpc.mock.calls.some(([, args]) => args.startsWith('propose '))).toBe(true),
    );
    const [, args] = fixture.rpc.mock.calls.find(([, value]) => value.startsWith('propose '))!;
    expect(JSON.parse(args.slice(8)).checks).toEqual([
      { id: 'check_1', kind: 'json_equals', path: 'package.json', pointer: '/name', value: 'demo' },
    ]);
  });
  it('preserves declared checks while editing a proposal', async () => {
    const rule = { id: 'marker', kind: 'contains_text', path: 'src/a.ts', text: 'required' };
    fixture.rpc.mockImplementation(async (_name: string, args: string) =>
      args.startsWith('list-json')
        ? page
        : { message: JSON.stringify({ ...record, checks: [rule] }) },
    );
    render(<ArchitectureDecisionsPanel sessionId="conversation-a" />);
    fireEvent.click(await screen.findByRole('button', { name: /Provider boundary/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'activity:adr.edit' }));
    expect((screen.getByLabelText('activity:adr.checks.path') as HTMLInputElement).value).toBe(
      'src/a.ts',
    );
    fireEvent.click(screen.getByRole('button', { name: 'activity:adr.saveProposal' }));
    await waitFor(() =>
      expect(fixture.rpc.mock.calls.some(([, args]) => args.startsWith('revise '))).toBe(true),
    );
    const [, args] = fixture.rpc.mock.calls.find(([, value]) => value.startsWith('revise '))!;
    expect(JSON.parse(args.slice(7)).proposal.checks).toEqual([rule]);
  });

  it('runs accepted checks and displays a blocked outcome without presenting success', async () => {
    const accepted = {
      ...record,
      status: 'accepted',
      checks: [{ id: 'marker', kind: 'file_exists', path: 'src/a.ts' }],
    };
    fixture.rpc.mockImplementation(async (_name: string, args: string) =>
      args.startsWith('list-json')
        ? page
        : {
            message: JSON.stringify(
              args.startsWith('check-json')
                ? {
                    projectId: record.projectId,
                    checkedAt: 'now',
                    status: 'blocked',
                    results: [{ checkId: 'marker', path: 'src/a.ts', status: 'blocked' }],
                  }
                : accepted,
            ),
          },
    );
    render(<ArchitectureDecisionsPanel sessionId="conversation-a" />);
    fireEvent.click(await screen.findByRole('button', { name: /Provider boundary/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'activity:adr.checks.run' }));
    expect((await screen.findByRole('status')).textContent).toContain(
      'activity:adr.checks.status.blocked',
    );
    expect(fixture.rpc).toHaveBeenCalledWith('adr', `check-json ${record.id}`, {
      sessionId: 'conversation-a',
    });
  });

  it('requires an explicit user reason and submits the exact displayed revision and hash', async () => {
    render(<ArchitectureDecisionsPanel sessionId="conversation-a" />);
    fireEvent.click(await screen.findByRole('button', { name: /Provider boundary/ }));
    const accept = await screen.findByRole('button', { name: 'activity:adr.accept' });
    expect((accept as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('activity:adr.reason'), {
      target: { value: 'Reviewed the alternatives' },
    });
    fireEvent.click(accept);
    await waitFor(() =>
      expect(fixture.rpc).toHaveBeenCalledWith(
        'adr',
        `review ${JSON.stringify({ projectId: 'project-a', id: record.id, revision: 3, contentHash: record.contentHash, action: 'accept', reason: 'Reviewed the alternatives' })}`,
        { sessionId: 'conversation-a' },
      ),
    );
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('surfaces rejected/stale reviews without pretending the proposal was accepted', async () => {
    fixture.rpc.mockImplementation(async (_name: string, args: string) =>
      args.startsWith('review ')
        ? { error: 'ADR changed since review' }
        : args.startsWith('list-json')
          ? page
          : { message: JSON.stringify(record) },
    );
    render(<ArchitectureDecisionsPanel sessionId="conversation-a" />);
    fireEvent.click(await screen.findByRole('button', { name: /Provider boundary/ }));
    fireEvent.change(await screen.findByLabelText('activity:adr.reason'), {
      target: { value: 'Reviewed' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'activity:adr.accept' }));
    expect((await screen.findByRole('alert')).textContent).toContain('changed since review');
    expect(screen.queryByText('activity:adr.saved')).toBeNull();
  });

  it('ignores an old project response after the panel switches projects', async () => {
    let resolveOld!: (value: unknown) => void;
    fixture.rpc.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
    );
    const view = render(<ArchitectureDecisionsPanel sessionId="conversation-a" />);
    fixture.projectRoot = 'project-b';
    fixture.rpc.mockResolvedValue({
      message: JSON.stringify({ records: [], total: 0, nextOffset: null }),
    });
    view.rerender(<ArchitectureDecisionsPanel sessionId="conversation-b" />);
    await screen.findByText('activity:adr.empty');
    await act(async () => {
      resolveOld(page);
    });
    expect(screen.queryByRole('button', { name: /Provider boundary/ })).toBeNull();
  });

  it('saves a proposal without activating it or sending an acceptance request', async () => {
    render(<ArchitectureDecisionsPanel sessionId="conversation-a" />);
    await screen.findByRole('button', { name: /Provider boundary/ });
    fireEvent.click(screen.getByRole('button', { name: 'activity:adr.new' }));
    for (const [key, value] of Object.entries({
      title: 'New boundary',
      context: 'Recurring choice',
      decision: 'Use a port',
    })) {
      fireEvent.change(screen.getByLabelText(`activity:adr.fields.${key}`), { target: { value } });
    }
    fireEvent.change(screen.getByLabelText('activity:adr.fields.constraints'), {
      target: { value: 'Keep contracts independent\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'activity:adr.saveProposal' }));
    await waitFor(() =>
      expect(fixture.rpc.mock.calls.some(([, args]) => args.startsWith('propose '))).toBe(true),
    );
    const [, args] = fixture.rpc.mock.calls.find(([, value]) => value.startsWith('propose '))!;
    expect(JSON.parse(args.slice(8)).constraints).toEqual(['Keep contracts independent']);
    expect(fixture.rpc.mock.calls.some(([, value]) => value.startsWith('review '))).toBe(false);
  });
});
