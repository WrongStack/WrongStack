'use client';

/**
 * Notifications — where HQ reaches the operator when they are not looking at
 * it: alerts, machines that drop out (and come back), approvals and questions
 * left waiting. Channels are webhooks, Slack, Discord or an ntfy topic (phone
 * push). A channel URL is a credential: the server stores it owner-only and
 * only ever shows it masked; changing it means pasting a new one.
 */
import {
  addNotifyChannel,
  fetchNotifySettings,
  HqHttpError,
  type NotifyChannelInput,
  removeNotifyChannel,
  saveNotifySettings,
  testNotifyChannel,
  updateNotifyChannel,
} from '@hq/data/api';
import type { HqNotifyChannelView, HqNotifySettingsView } from '@wrongstack/hq';
import { BellRing, Send, Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useId, useState } from 'react';
import { relativeTime } from '@/features/attention/model';
import { splitLabels } from '@/features/machines/machine-labels';
import { cn } from '@/lib/cn';
import { errorText } from '@/lib/error-text';
import { AlertRulesForm } from './alert-rules-form';

type Kind = HqNotifyChannelView['kinds'][number];
type ChannelType = HqNotifyChannelView['type'];

const KINDS: { kind: Kind; label: string; hint: string }[] = [
  { kind: 'alert', label: 'Alerts', hint: 'An alert rule starts firing' },
  { kind: 'machine', label: 'Machines', hint: 'A machine goes offline or comes back' },
  { kind: 'approval', label: 'Approvals', hint: 'A tool call waits for a decision' },
  { kind: 'question', label: 'Questions', hint: 'A model waits for an answer' },
];

const TYPES: { type: ChannelType; label: string; placeholder: string; hint: string }[] = [
  {
    type: 'ntfy',
    label: 'ntfy (phone push)',
    placeholder: 'https://ntfy.sh/your-private-topic',
    hint: 'Install the ntfy app, subscribe to a hard-to-guess topic and paste its URL. Self-hosted servers work too; add ?auth=<token> for a protected topic.',
  },
  {
    type: 'slack',
    label: 'Slack',
    placeholder: 'https://hooks.slack.com/services/…',
    hint: 'An incoming-webhook URL from a Slack app installed in the channel you want.',
  },
  {
    type: 'discord',
    label: 'Discord',
    placeholder: 'https://discord.com/api/webhooks/…',
    hint: 'Channel settings → Integrations → Webhooks → Copy webhook URL.',
  },
  {
    type: 'webhook',
    label: 'Webhook (JSON)',
    placeholder: 'https://example.com/hq-hook',
    hint: 'HQ POSTs {type, kind, severity, title, body, link, at} as JSON.',
  },
];

const SEVERITY_LABEL = { info: 'All alerts', warn: 'Warnings and errors', error: 'Errors only' };

const field = 'h-10 w-full border border-border bg-background px-3 text-sm disabled:opacity-60';
const button =
  'inline-flex h-9 items-center gap-2 border border-border px-3 text-sm hover:bg-muted disabled:opacity-60';

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

export function NotificationsView(): ReactNode {
  const [settings, setSettings] = useState<HqNotifySettingsView | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const now = useNow();

  const reload = useCallback(async (): Promise<void> => {
    try {
      setSettings(await fetchNotifySettings());
      setRefused(null);
    } catch (cause) {
      setRefused(
        cause instanceof HqHttpError && cause.status === 403
          ? `Notifications need an admin sign-in. ${cause.message.replace(/^403\s*/, '')}`
          : errorText(cause),
      );
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-6">
      <header className="flex flex-col gap-1">
        <h2 className="flex items-center gap-2 font-display text-2xl font-semibold">
          <BellRing className="size-5" />
          Notifications
        </h2>
        <p className="text-base text-muted-foreground">
          HQ tells you when something needs you and you are not looking: an alert fires (including a
          daily budget a project or machine crossed), a machine drops out, an approval or question
          is left waiting. Only summaries are sent — never tool arguments, transcripts or tokens.
        </p>
      </header>

      {refused !== null && (
        <p role="alert" className="border border-warning/60 px-4 py-3 text-sm">
          {refused}
        </p>
      )}

      {settings !== null && (
        <>
          <ChannelList settings={settings} now={now} onChanged={reload} />
          <AddChannel onAdded={reload} />
          <Settings settings={settings} onSaved={setSettings} />
          <AlertRulesForm />
        </>
      )}
    </div>
  );
}

function ChannelList({
  settings,
  now,
  onChanged,
}: {
  settings: HqNotifySettingsView;
  now: number;
  onChanged: () => Promise<void>;
}): ReactNode {
  if (settings.channels.length === 0) {
    return (
      <section className="border border-dashed border-border px-5 py-6 text-sm text-muted-foreground">
        No channel yet. Until you add one, HQ only shows what needs you on this dashboard.
      </section>
    );
  }
  return (
    <section className="flex flex-col gap-2" aria-label="Channels">
      <h3 className="text-sm font-semibold">Channels</h3>
      <ul className="flex flex-col gap-2">
        {settings.channels.map((channel) => (
          <ChannelRow key={channel.id} channel={channel} now={now} onChanged={onChanged} />
        ))}
      </ul>
    </section>
  );
}

function ChannelRow({
  channel,
  now,
  onChanged,
}: {
  channel: HqNotifyChannelView;
  now: number;
  onChanged: () => Promise<void>;
}): ReactNode {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const type = TYPES.find((entry) => entry.type === channel.type);

  const run = async (work: () => Promise<string>): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ ok: true, text: await work() });
    } catch (cause) {
      setMessage({ ok: false, text: errorText(cause) });
    } finally {
      setBusy(false);
      await onChanged();
    }
  };

  return (
    <li
      data-channel={channel.id}
      className={cn(
        'flex flex-col gap-3 border border-border p-4',
        !channel.enabled && 'opacity-80',
      )}
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {channel.name}
            {!channel.enabled && <span className="ml-2 text-xs text-muted-foreground">paused</span>}
          </p>
          <p className="truncate text-sm text-muted-foreground">
            {type?.label ?? channel.type} · <span className="font-mono">{channel.maskedUrl}</span>
          </p>
          <p className="text-sm">
            {channel.kinds
              .map((kind) => KINDS.find((entry) => entry.kind === kind)?.label ?? kind)
              .join(' · ')}
            {channel.kinds.includes('alert') && ` · ${SEVERITY_LABEL[channel.minSeverity]}`}
          </p>
          <ChannelMachines channel={channel} disabled={busy} run={run} />
          <p className="text-xs text-muted-foreground">
            {channel.lastDeliveredAt !== undefined
              ? `Last delivered ${relativeTime(channel.lastDeliveredAt, now)} · ${channel.delivered} sent`
              : 'Nothing delivered since HQ started'}
            {channel.dropped > 0 && ` · ${channel.dropped} held back by the rate limit`}
          </p>
          {channel.lastError !== undefined && (
            <p className="text-xs text-destructive">
              Failed {relativeTime(channel.lastError.at, now)}: {channel.lastError.message}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            disabled={busy}
            data-testid="notify-test"
            className={button}
            onClick={() =>
              void run(async () => {
                await testNotifyChannel(channel.id);
                return 'Test message delivered.';
              })
            }
          >
            <Send className="size-4" />
            Send a test
          </button>
          <button
            type="button"
            disabled={busy}
            className={button}
            onClick={() =>
              void run(async () => {
                await updateNotifyChannel(channel.id, { enabled: !channel.enabled });
                return channel.enabled ? 'Paused.' : 'Resumed.';
              })
            }
          >
            {channel.enabled ? 'Pause' : 'Resume'}
          </button>
          {confirmRemove ? (
            <>
              <button
                type="button"
                disabled={busy}
                className={cn(
                  button,
                  'border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90',
                )}
                onClick={() =>
                  void run(async () => {
                    await removeNotifyChannel(channel.id);
                    return 'Removed.';
                  })
                }
              >
                <Trash2 className="size-4" />
                Remove {channel.name}
              </button>
              <button type="button" className={button} onClick={() => setConfirmRemove(false)}>
                Keep
              </button>
            </>
          ) : (
            <button type="button" className={button} onClick={() => setConfirmRemove(true)}>
              <Trash2 className="size-4" />
              Remove
            </button>
          )}
        </div>
      </div>
      {message !== null && (
        <p
          role="status"
          className={cn('text-sm', message.ok ? 'text-success' : 'text-destructive')}
        >
          {message.text}
        </p>
      )}
    </li>
  );
}

function AddChannel({ onAdded }: { onAdded: () => Promise<void> }): ReactNode {
  const id = useId();
  const [type, setType] = useState<ChannelType>('ntfy');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [kinds, setKinds] = useState<Kind[]>(['alert', 'machine', 'approval', 'question']);
  const [minSeverity, setMinSeverity] =
    useState<NonNullable<NotifyChannelInput['minSeverity']>>('warn');
  const [machineLabels, setMachineLabels] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = TYPES.find((entry) => entry.type === type) ?? TYPES[0]!;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await addNotifyChannel({
        name: name.trim() || selected.label,
        type,
        url,
        kinds,
        minSeverity,
        machineLabels: splitLabels(machineLabels),
      });
      setName('');
      setUrl('');
      setMachineLabels('');
      await onAdded();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="flex flex-col gap-4 border border-border p-5" aria-label="Add a channel">
      <h3 className="text-sm font-semibold">Add a channel</h3>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-type`} className="text-sm font-medium">
              Where
            </label>
            <select
              id={`${id}-type`}
              className={field}
              value={type}
              onChange={(event) => setType(event.target.value as ChannelType)}
            >
              {TYPES.map((entry) => (
                <option key={entry.type} value={entry.type}>
                  {entry.label}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-name`} className="text-sm font-medium">
              Name
            </label>
            <input
              id={`${id}-name`}
              className={field}
              value={name}
              maxLength={80}
              placeholder={selected.label}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-url`} className="text-sm font-medium">
            URL
          </label>
          <input
            id={`${id}-url`}
            type="url"
            required
            autoComplete="off"
            spellCheck={false}
            className={cn(field, 'font-mono')}
            value={url}
            placeholder={selected.placeholder}
            onChange={(event) => setUrl(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            {selected.hint} The URL is a secret: HQ keeps it in an owner-only file and shows it
            masked from now on.
          </p>
        </div>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Tell me about</legend>
          {KINDS.map((entry) => (
            <label key={entry.kind} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={kinds.includes(entry.kind)}
                onChange={(event) =>
                  setKinds((current) =>
                    event.target.checked
                      ? [...current, entry.kind]
                      : current.filter((kind) => kind !== entry.kind),
                  )
                }
              />
              <span>{entry.label}</span>
              <span className="text-muted-foreground">— {entry.hint}</span>
            </label>
          ))}
        </fieldset>
        {kinds.includes('alert') && (
          <div className="flex flex-col gap-1.5 sm:max-w-xs">
            <label htmlFor={`${id}-severity`} className="text-sm font-medium">
              Alerts to send
            </label>
            <select
              id={`${id}-severity`}
              className={field}
              value={minSeverity}
              onChange={(event) => setMinSeverity(event.target.value as typeof minSeverity)}
            >
              {(Object.keys(SEVERITY_LABEL) as (keyof typeof SEVERITY_LABEL)[]).map((key) => (
                <option key={key} value={key}>
                  {SEVERITY_LABEL[key]}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="flex flex-col gap-1.5 sm:max-w-md">
          <label htmlFor={`${id}-labels`} className="text-sm font-medium">
            Only machines labelled
          </label>
          <input
            id={`${id}-labels`}
            className={cn(field, 'font-mono')}
            value={machineLabels}
            onChange={(event) => setMachineLabels(event.target.value)}
            placeholder="prod gpu"
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${id}-labels-hint`}
          />
          <p id={`${id}-labels-hint`} className="text-xs text-muted-foreground">
            Leave empty to hear about every machine. Fleet-wide alerts, and requests HQ cannot place
            on a machine, arrive either way.
          </p>
        </div>
        {error !== null && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div>
          <button
            type="submit"
            disabled={busy || url.trim() === '' || kinds.length === 0}
            className="inline-flex h-10 items-center bg-primary px-5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-60"
          >
            {busy ? 'Adding…' : 'Add channel'}
          </button>
        </div>
      </form>
    </section>
  );
}

function Settings({
  settings,
  onSaved,
}: {
  settings: HqNotifySettingsView;
  onSaved: (next: HqNotifySettingsView) => void;
}): ReactNode {
  const id = useId();
  const [publicUrl, setPublicUrl] = useState(settings.publicUrl ?? '');
  const [delay, setDelay] = useState(String(settings.approvalDelaySeconds));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const suggested = typeof window === 'undefined' ? '' : window.location.origin;

  const save = async (): Promise<void> => {
    setBusy(true);
    setMessage(null);
    try {
      onSaved(
        await saveNotifySettings({
          publicUrl: publicUrl.trim() === '' ? null : publicUrl.trim(),
          approvalDelaySeconds: Number(delay),
        }),
      );
      setMessage({ ok: true, text: 'Saved.' });
    } catch (cause) {
      setMessage({ ok: false, text: errorText(cause) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section
      className="flex flex-col gap-4 border border-border p-5"
      aria-label="Delivery settings"
    >
      <h3 className="text-sm font-semibold">Delivery</h3>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-public`} className="text-sm font-medium">
            HQ address for links
          </label>
          <input
            id={`${id}-public`}
            type="url"
            className={cn(field, 'font-mono')}
            value={publicUrl}
            placeholder={suggested}
            onChange={(event) => setPublicUrl(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Each notification links to the right HQ screen when this is set. Use an address your
            phone can open; leave it empty to send no links.
          </p>
        </div>
        <div className="flex flex-col gap-1.5 sm:max-w-xs">
          <label htmlFor={`${id}-delay`} className="text-sm font-medium">
            Wait before pushing an approval or question (seconds)
          </label>
          <input
            id={`${id}-delay`}
            type="number"
            min={0}
            max={3600}
            className={field}
            value={delay}
            onChange={(event) => setDelay(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            One answered at the terminal within this time is never pushed.
          </p>
        </div>
        {message !== null && (
          <p
            role="status"
            className={cn('text-sm', message.ok ? 'text-success' : 'text-destructive')}
          >
            {message.text}
          </p>
        )}
        <div>
          <button type="submit" disabled={busy} className={button}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </section>
  );
}

/**
 * Which machines a channel hears about: every one, or only those carrying
 * some labels. Changed in place; the server validates the labels.
 */
function ChannelMachines({
  channel,
  disabled,
  run,
}: {
  channel: HqNotifyChannelView;
  disabled: boolean;
  run: (work: () => Promise<string>) => Promise<void>;
}): ReactNode {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const inputId = useId();
  const labels = channel.machineLabels;
  if (editing) {
    return (
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            const next = splitLabels(text);
            await updateNotifyChannel(channel.id, { machineLabels: next });
            setEditing(false);
            return next.length === 0
              ? 'Now hears about every machine.'
              : `Now hears only about ${next.join(', ')} machines.`;
          });
        }}
      >
        <label htmlFor={inputId} className="flex flex-col gap-1 text-xs text-muted-foreground">
          Only machines labelled (empty: every machine)
          <input
            id={inputId}
            value={text}
            onChange={(event) => setText(event.target.value)}
            className={cn(field, 'h-8 font-mono')}
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <button type="submit" disabled={disabled} className={button}>
          Save
        </button>
        <button
          type="button"
          disabled={disabled}
          className="inline-flex h-8 items-center px-2 text-sm text-muted-foreground hover:text-foreground"
          onClick={() => setEditing(false)}
        >
          Cancel
        </button>
      </form>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm" data-testid="channel-machines">
      {labels.length === 0 ? (
        <span>Every machine</span>
      ) : (
        <span>
          Only <span className="font-mono">{labels.join(', ')}</span> machines
        </span>
      )}
      <button
        type="button"
        disabled={disabled}
        className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        onClick={() => {
          setText(labels.join(' '));
          setEditing(true);
        }}
      >
        Change
      </button>
    </p>
  );
}
