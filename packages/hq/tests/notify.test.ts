import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type HqNotification, HqNotifier } from '../src/notifier.js';
import { maskHqNotifyUrl, validateHqNotifyUrl } from '../src/notify-config.js';
import { HqMachineWatch, HqPendingRequestWatch } from '../src/notify-watchers.js';
import type { HqEventEnvelope, HqKnownMachine } from '../src/protocol.js';

const SLACK = 'https://hooks.slack.com/services/T000/B000/SECRETxyz9';

describe('notification URLs', () => {
  it('accepts https anywhere and http only to a private host', () => {
    expect(validateHqNotifyUrl(SLACK).ok).toBe(true);
    expect(validateHqNotifyUrl('http://192.168.1.20:8080/alerts').ok).toBe(true);
    expect(validateHqNotifyUrl('http://ntfy.home.arpa/hq').ok).toBe(true);
    expect(validateHqNotifyUrl('http://example.com/hook')).toMatchObject({ ok: false });
    expect(validateHqNotifyUrl('javascript:alert(1)')).toMatchObject({ ok: false });
    expect(validateHqNotifyUrl('file:///etc/passwd')).toMatchObject({ ok: false });
    expect(validateHqNotifyUrl('https://user:pw@example.com/')).toMatchObject({ ok: false });
  });

  it('masks a URL down to its origin and last four characters', () => {
    const masked = maskHqNotifyUrl(SLACK);
    expect(masked).toBe('https://hooks.slack.com/…xyz9');
    expect(masked).not.toContain('SECRET');
  });
});

describe('channel request formats', () => {
  const note = {
    kind: 'machine' as const,
    severity: 'warn' as const,
    title: 'LAB-02 went offline',
    body: 'No client since 10:00.',
    dedupeKey: 'k',
  };
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-notify-format-'));
  });
  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  /** What one channel receives for one note, through the real notifier. */
  async function deliver(
    type: 'webhook' | 'slack' | 'discord' | 'ntfy',
    url: string,
    sent: Partial<typeof note> & { path?: string } = {},
    publicUrl?: string,
  ): Promise<{ url: string; body: Record<string, unknown> }> {
    const requests: { url: string; init: RequestInit }[] = [];
    const notifier = new HqNotifier(dataDir, {
      fetch: async (target, init) => {
        requests.push({ url: target, init });
        return { ok: true, status: 200 };
      },
    });
    await notifier.addChannel({ name: type, type, url, kinds: ['machine'] });
    if (publicUrl !== undefined) await notifier.updateSettings({ publicUrl });
    notifier.notify({ ...note, ...sent, dedupeKey: `${type}:${Math.random()}` });
    await notifier.drain();
    await fs.rm(path.join(dataDir, 'notify.json'), { force: true });
    const [request] = requests;
    if (request === undefined) throw new Error('nothing was sent');
    return { url: request.url, body: JSON.parse(String(request.init.body)) };
  }

  it('posts Slack text, Discord content without mentions and generic JSON', async () => {
    const slack = await deliver('slack', SLACK, { path: '/x' }, 'https://hq/');
    expect(slack.body).toEqual({
      text: '*LAB-02 went offline*\nNo client since 10:00.\n<https://hq/x|Open in WrongStack HQ>',
    });
    const discord = await deliver('discord', 'https://discord.com/api/webhooks/1/abc');
    expect(discord.body).toMatchObject({
      content: '**LAB\\-02 went offline**\nNo client since 10:00.',
      allowed_mentions: { parse: [] },
    });
    const generic = await deliver('webhook', 'https://x.test/h');
    expect(generic.body).toMatchObject({
      type: 'wrongstack.hq.notification',
      kind: 'machine',
      severity: 'warn',
    });
  });

  it('neutralizes client text that would ping a channel or plant a link', async () => {
    const hostile = {
      title: 'Question waiting on <!channel>',
      body: '<https://evil.example|Open in WrongStack HQ> [phish](https://evil.example) @everyone',
    };
    const slack = (await deliver('slack', SLACK, hostile)).body as { text: string };
    expect(slack.text).not.toContain('<!channel>');
    expect(slack.text).not.toContain('<https://evil.example');
    expect(slack.text).toContain('&lt;!channel&gt;');
    const discord = (await deliver('discord', 'https://discord.com/api/webhooks/1/abc', hostile))
      .body as { content: string; allowed_mentions: unknown };
    expect(discord.content).not.toContain('[phish](');
    expect(discord.allowed_mentions).toEqual({ parse: [] });
  });

  it('keeps the path prefix of an HQ served under a sub-path', async () => {
    const link = async (publicUrl: string, notePath: string): Promise<unknown> =>
      (await deliver('webhook', 'https://x.test/h', { path: notePath }, publicUrl)).body.link;
    expect(await link('https://host/hq', '/inbox/')).toBe('https://host/hq/inbox/');
    expect(await link('https://host/hq/', '/fleet/machines/?machine=host%3Alab')).toBe(
      'https://host/hq/fleet/machines/?machine=host%3Alab',
    );
    expect(await link('https://host/', '/inbox/')).toBe('https://host/inbox/');
    expect((await deliver('webhook', 'https://x.test/h', { path: '/inbox/' })).body.link).toBe(
      undefined,
    );
  });

  it('publishes ntfy as JSON to the server root, keeping the query (access token)', async () => {
    const request = await deliver(
      'ntfy',
      'https://ntfy.sh/wrongstack-hq?auth=tk',
      { path: '/x' },
      'https://hq/',
    );
    expect(request.url).toBe('https://ntfy.sh/?auth=tk');
    expect(request.body).toMatchObject({
      topic: 'wrongstack-hq',
      title: 'LAB-02 went offline',
      priority: 4,
      click: 'https://hq/x',
    });
  });
});

describe('HqNotifier', () => {
  let dataDir: string;
  let sent: { url: string; init: RequestInit }[];
  let answer: { ok: boolean; status: number } | Error;
  let clock: number;
  const make = (): HqNotifier =>
    new HqNotifier(dataDir, {
      now: () => clock,
      fetch: async (url, init) => {
        sent.push({ url, init });
        if (answer instanceof Error) throw answer;
        return answer;
      },
    });

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-notify-'));
    sent = [];
    answer = { ok: true, status: 200 };
    clock = Date.parse('2026-11-01T10:00:00.000Z');
  });
  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('stores the URL on disk but only ever shows it masked', async () => {
    const notifier = make();
    const added = await notifier.addChannel({
      name: 'Ops',
      type: 'slack',
      url: SLACK,
      kinds: ['alert', 'machine'],
    });
    expect(added.ok).toBe(true);
    expect(JSON.stringify(notifier.view())).not.toContain('SECRET');
    expect(await fs.readFile(path.join(dataDir, 'notify.json'), 'utf8')).toContain(SLACK);

    const reloaded = make();
    await reloaded.load();
    expect(reloaded.view().channels.map((channel) => channel.name)).toEqual(['Ops']);
  });

  it('refuses bad input with a reason', async () => {
    const notifier = make();
    expect(
      await notifier.addChannel({
        name: 'x',
        type: 'slack',
        url: 'http://example.com',
        kinds: ['alert'],
      }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await notifier.addChannel({ name: 'x', type: 'pager', url: SLACK, kinds: ['alert'] }),
    ).toMatchObject({ ok: false, status: 400 });
    expect(
      await notifier.addChannel({ name: 'x', type: 'slack', url: SLACK, kinds: [] }),
    ).toMatchObject({ ok: false, status: 400 });
  });

  it('routes by kind and alert severity, dedupes repeats and never follows redirects', async () => {
    const notifier = make();
    await notifier.addChannel({
      name: 'A',
      type: 'webhook',
      url: 'https://a.test/h',
      kinds: ['alert'],
      minSeverity: 'error',
    });
    await notifier.addChannel({
      name: 'M',
      type: 'webhook',
      url: 'https://m.test/h',
      kinds: ['machine'],
    });
    notifier.notify({ kind: 'alert', severity: 'warn', title: 't', body: 'b', dedupeKey: 'a1' });
    notifier.notify({ kind: 'alert', severity: 'error', title: 't', body: 'b', dedupeKey: 'a2' });
    notifier.notify({ kind: 'alert', severity: 'error', title: 't', body: 'b', dedupeKey: 'a2' });
    notifier.notify({ kind: 'machine', severity: 'info', title: 't', body: 'b', dedupeKey: 'm1' });
    await notifier.drain();
    expect(sent.map((entry) => entry.url)).toEqual(['https://a.test/h', 'https://m.test/h']);
    expect(sent.every((entry) => entry.init.redirect === 'error')).toBe(true);
  });

  it('limits a channel to labelled machines, never dropping what is about no machine', async () => {
    const notifier = make();
    notifier.setMachineLabels((key) => (key === 'host:prod-1' ? ['prod'] : ['lab']));
    const added = await notifier.addChannel({
      name: 'Prod only',
      type: 'webhook',
      url: 'https://p.test/h',
      kinds: ['machine', 'alert', 'approval'],
      machineLabels: [' Prod '],
    });
    expect(added).toMatchObject({ ok: true, value: { machineLabels: ['prod'] } });
    const note = (dedupeKey: string, machineKey?: string) =>
      notifier.notify({
        kind: 'machine',
        severity: 'warn',
        title: 't',
        body: 'b',
        dedupeKey,
        ...(machineKey !== undefined ? { machineKey } : {}),
      });
    note('about-prod', 'host:prod-1');
    note('about-lab', 'host:lab-2');
    note('about-no-machine');
    await notifier.drain();
    const bodies = sent.map((entry) => String(entry.init.body));
    expect(bodies).toHaveLength(2);

    // Bad labels are refused; `[]` lifts the limit; a partial update keeps it.
    const id = notifier.view().channels[0]!.id;
    expect(await notifier.updateChannel(id, { machineLabels: ['no spaces'] })).toMatchObject({
      ok: false,
      status: 400,
    });
    expect(await notifier.updateChannel(id, { name: 'Renamed' })).toMatchObject({
      ok: true,
      value: { machineLabels: ['prod'] },
    });
    expect(await notifier.updateChannel(id, { machineLabels: [] })).toMatchObject({
      ok: true,
      value: { machineLabels: [] },
    });
    note('about-lab-again', 'host:lab-2');
    await notifier.drain();
    expect(sent).toHaveLength(3);
  });

  it('rate-limits a channel and counts what it dropped', async () => {
    const notifier = make();
    await notifier.addChannel({
      name: 'M',
      type: 'webhook',
      url: 'https://m.test/h',
      kinds: ['machine'],
    });
    for (let i = 0; i < 14; i++) {
      notifier.notify({
        kind: 'machine',
        severity: 'info',
        title: 't',
        body: 'b',
        dedupeKey: `k${i}`,
      });
    }
    await notifier.drain();
    expect(sent).toHaveLength(10);
    expect(notifier.view().channels[0]).toMatchObject({ delivered: 10, dropped: 4 });
  });

  it('does not swallow a note that every channel held back for its rate limit', async () => {
    const notifier = make();
    await notifier.addChannel({
      name: 'M',
      type: 'webhook',
      url: 'https://m.test/h',
      kinds: ['machine'],
    });
    for (let i = 0; i < 10; i++) {
      notifier.notify({
        kind: 'machine',
        severity: 'info',
        title: 't',
        body: 'b',
        dedupeKey: `k${i}`,
      });
    }
    notifier.notify({
      kind: 'machine',
      severity: 'info',
      title: 'held',
      body: 'b',
      dedupeKey: 'late',
    });
    await notifier.drain();
    expect(sent).toHaveLength(10);
    // A minute later the window has room again, and the held note goes out.
    clock += 61_000;
    notifier.notify({
      kind: 'machine',
      severity: 'info',
      title: 'held',
      body: 'b',
      dedupeKey: 'late',
    });
    await notifier.drain();
    expect(sent).toHaveLength(11);
  });

  it('records a failure without echoing the secret URL', async () => {
    const notifier = make();
    const added = await notifier.addChannel({
      name: 'Ops',
      type: 'slack',
      url: SLACK,
      kinds: ['alert'],
    });
    answer = new Error(`getaddrinfo ENOTFOUND ${SLACK}`);
    const outcome = await notifier.test(added.ok ? added.value.id : '');
    expect(outcome).toMatchObject({ ok: false, status: 502 });
    const view = JSON.stringify(notifier.view());
    expect(view).toContain('could not be reached');
    expect(view).not.toContain('SECRET');
  });

  it('links to the dashboard only when a public URL is set', async () => {
    const notifier = make();
    await notifier.addChannel({
      name: 'G',
      type: 'webhook',
      url: 'https://g.test/h',
      kinds: ['machine'],
    });
    expect((await notifier.updateSettings({ publicUrl: 'http://example.com' })).ok).toBe(false);
    await notifier.updateSettings({
      publicUrl: 'https://hq.example.com/',
      approvalDelaySeconds: 99_999,
    });
    expect(notifier.view()).toMatchObject({
      publicUrl: 'https://hq.example.com/',
      approvalDelaySeconds: 3600,
    });
    notifier.notify({
      kind: 'machine',
      severity: 'info',
      title: 't',
      body: 'b',
      dedupeKey: 'x',
      path: '/fleet/machines/?machine=host%3Alab',
    });
    await notifier.drain();
    expect(JSON.parse(String(sent[0]?.init.body)).link).toBe(
      'https://hq.example.com/fleet/machines/?machine=host%3Alab',
    );
  });
});

describe('HqMachineWatch', () => {
  const machine = (key: string, lastSeenAt: number): HqKnownMachine => ({
    key,
    hostname: key.slice(5).toUpperCase(),
    machineIds: [],
    projects: [{ projectId: 'p', projectName: 'Datapipe' }],
    firstSeenAt: new Date(0).toISOString(),
    lastSeenAt: new Date(lastSeenAt).toISOString(),
  });
  const label = (key: string) => key;

  it('announces a machine it saw online once it is silent past the grace, then its return', () => {
    const watch = new HqMachineWatch(60_000);
    expect(watch.observe(new Set(['host:lab']), [], 0, label)).toEqual([]);
    // Silent, but inside the grace period: a reconnect blip is not news.
    expect(watch.observe(new Set(), [machine('host:lab', 0)], 30_000, label)).toEqual([]);
    const offline = watch.observe(new Set(), [machine('host:lab', 0)], 61_000, label);
    expect(offline.map((note) => note.title)).toEqual(['LAB went offline']);
    // Each machine note names its machine, so a channel can be limited to labels.
    expect(offline[0]?.machineKey).toBe('host:lab');
    expect(watch.observe(new Set(), [machine('host:lab', 0)], 90_000, label)).toEqual([]);
    const back = watch.observe(new Set(['host:lab']), [], 120_000, label);
    expect(back.map((note) => note.title)).toEqual(['host:lab is back online']);
  });

  it('never announces a machine that was already offline when HQ started', () => {
    const watch = new HqMachineWatch(60_000);
    expect(watch.observe(new Set(), [machine('host:old', 0)], 999_999, label)).toEqual([]);
  });
});

describe('HqPendingRequestWatch', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const event = (type: string, payload: unknown): HqEventEnvelope =>
    ({
      id: 'e',
      type,
      schemaVersion: 1,
      timestamp: 'T',
      clientId: 'c1',
      projectId: 'p',
      payload,
    }) as HqEventEnvelope;
  const origin = { hostname: 'LAB-02', projectName: 'Datapipe' };

  it('pushes an approval still waiting after the delay, not one answered in time', () => {
    const emitted: string[] = [];
    let connected = true;
    const watch = new HqPendingRequestWatch({
      delayMs: () => 60_000,
      stillConnected: () => connected,
      emit: (note) => emitted.push(`${note.severity}:${note.title}`),
    });
    watch.observe(
      event('approval.requested', { toolUseId: 'a', toolName: 'bash', destructive: true }),
      origin,
    );
    watch.observe(event('approval.requested', { toolUseId: 'b', toolName: 'edit' }), origin);
    watch.observe(event('approval.resolved', { toolUseId: 'b' }), origin);
    watch.observe(
      event('user_input.requested', { request: { id: 'q', title: 'Which branch?' } }),
      origin,
    );
    vi.advanceTimersByTime(59_000);
    expect(emitted).toEqual([]);
    connected = true;
    vi.advanceTimersByTime(2_000);
    expect(emitted).toEqual([
      'error:Approval waiting: bash on LAB-02',
      'warn:Question waiting on LAB-02',
    ]);
    expect(watch.size()).toBe(0);

    // The client that asked is gone: the request is moot.
    connected = false;
    watch.observe(event('approval.requested', { toolUseId: 'c', toolName: 'bash' }), origin);
    vi.advanceTimersByTime(61_000);
    expect(emitted).toHaveLength(2);
  });

  it('names the machine a request came from, when the server knows it', () => {
    const notes: HqNotification[] = [];
    const watch = new HqPendingRequestWatch({
      delayMs: () => 0,
      stillConnected: () => true,
      emit: (note) => notes.push(note),
    });
    watch.observe(event('approval.requested', { toolUseId: 'k', toolName: 'bash' }), {
      ...origin,
      machineKey: 'host:lab-02',
    });
    watch.observe(event('approval.requested', { toolUseId: 'u', toolName: 'bash' }), origin);
    vi.advanceTimersByTime(1);
    expect(notes.map((note) => note.machineKey)).toEqual(['host:lab-02', undefined]);
    watch.close();
  });

  it('lets only the client that asked resolve it, and caps each client on its own', () => {
    const emitted: string[] = [];
    const watch = new HqPendingRequestWatch({
      delayMs: () => 1_000,
      stillConnected: () => true,
      emit: (note) => emitted.push(note.dedupeKey),
    });
    const from = (clientId: string, type: string, payload: unknown): HqEventEnvelope =>
      ({ ...event(type, payload), clientId }) as HqEventEnvelope;
    watch.observe(from('c1', 'approval.requested', { toolUseId: 'x', toolName: 'bash' }), origin);
    // Another client cannot cancel c1's timer by naming the same tool call.
    watch.observe(from('c2', 'approval.resolved', { toolUseId: 'x' }), origin);
    // A flood from c2 fills only its own share.
    for (let i = 0; i < 500; i++) {
      watch.observe(
        from('c2', 'approval.requested', { toolUseId: `f${i}`, toolName: 'bash' }),
        origin,
      );
    }
    watch.observe(from('c3', 'approval.requested', { toolUseId: 'y', toolName: 'bash' }), origin);
    expect(watch.size()).toBe(102);
    vi.advanceTimersByTime(1_000);
    expect(emitted).toContain('approval:x');
    expect(emitted).toContain('approval:y');
  });
});
