import {
  Bell,
  BellOff,
  CheckCircle,
  Clock,
  KeyRound,
  MessageSquare,
  Radio,
  RefreshCw,
  Send,
  Settings2,
  Shield,
  Timer,
} from 'lucide-react';
import { ExternalDoc, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';

export function TelegramPage() {
  return (
    <>
      <PageHero
        index="25"
        eyebrow="Telegram"
        title={
          <>
            Your agent
            <br />
            <span className="text-brand">in your pocket.</span>
          </>
        }
        description="Connect WrongStack to Telegram for push notifications, interactive approval prompts, and remote commands. The bot polls for messages, sends alerts on session events and long-running tools, and can relay your replies back to the agent."
        aside={<ExternalDoc path="docs/slash/telegram.md">Open Telegram docs</ExternalDoc>}
      />

      {/* ── How it works ───────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="How it works"
          title="Polling bot. No webhooks. No public IP."
          description="The Telegram plugin runs as part of your WrongStack session. It polls the Telegram API at a configurable interval — no webhook URL, no reverse proxy, no public endpoint needed."
        />
        <div className="mt-12 grid gap-6 lg:grid-cols-3">
          {[
            {
              icon: Radio,
              title: 'Polling engine',
              body: 'The bot polls `getUpdates` at a configurable interval (default 2 seconds, range 1–60). New messages are processed immediately. No webhook setup, no TLS certificate, no public IP required.',
              tag: 'no webhooks',
            },
            {
              icon: Bell,
              title: 'Event notifications',
              body: 'Configurable per event type. Get alerts when sessions end, delegated subagents finish, or tool calls exceed a duration threshold. Toggle each event independently or all at once.',
              tag: 'push alerts',
            },
            {
              icon: CheckCircle,
              title: 'Approval prompts',
              body: 'The agent can send yes/no approval prompts with inline keyboard buttons. Approve or deny destructive operations, deploys, and config changes from anywhere. Configurable timeout with auto-deny.',
              tag: 'interactive',
            },
          ].map(({ icon: Icon, title, body, tag }) => (
            <article key={title} className="rounded-2xl border border-line bg-card p-7">
              <Icon className="size-5 text-brand" />
              <div className="mt-8 flex items-center gap-2">
                <h2 className="text-lg font-black text-fg">{title}</h2>
                <span className="rounded-full border border-line bg-bg px-2 py-0.5 font-mono text-xs font-black uppercase text-faint">
                  {tag}
                </span>
              </div>
              <p className="mt-4 text-sm leading-7 text-muted">{body}</p>
            </article>
          ))}
        </div>
      </section>

      {/* ── Setup ───────────────────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Setup"
            title="Three steps from @BotFather to connected agent."
            description="Create a bot, pair it with your chat, and validate. The setup command performs a live getMe request before saving — no invalid tokens can be persisted."
          />
          <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-4">
            {[
              {
                step: '01',
                title: 'Create bot',
                body: 'Message @BotFather on Telegram. Use /newbot, pick a name and username. Copy the HTTP API token it gives you.',
              },
              {
                step: '02',
                title: 'Get chat ID',
                body: 'Message your new bot once. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser. Copy the `chat.id` from the response.',
              },
              {
                step: '03',
                title: 'Validate & save',
                body: 'Run `/telegram-setup <botToken> <chatId>`. The command calls getMe against the API. Only valid tokens are saved.',
              },
              {
                step: '04',
                title: 'Restart',
                body: 'Restart WrongStack so the Telegram plugin loads the new settings. The bot starts polling and is ready for notifications.',
              },
            ].map(({ step, title, body }) => (
              <article key={step} className="bg-card p-7">
                <span className="font-mono text-xs font-black text-brand-2">{step}</span>
                <h2 className="mt-6 text-xl font-black text-fg">{title}</h2>
                <p className="mt-3 text-sm leading-7 text-muted">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── Notification events ─────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Notifications"
          title="Fine-grained control over what reaches your phone."
          description="Every notification event is independently toggleable. Settings apply immediately — the plugin watches config changes, no restart needed after setup."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            {
              icon: Bell,
              cmd: '/telegram-settings session-end on|off',
              desc: 'Notify when a session completes. Includes session duration, tool call count, and final outcome.',
            },
            {
              icon: Send,
              cmd: '/telegram-settings delegate on|off',
              desc: 'Notify when a delegated subagent finishes. Default on. Shows task result and duration.',
            },
            {
              icon: Timer,
              cmd: '/telegram-settings long-tool <ms>|off',
              desc: 'Notify for tool calls slower than the threshold. Default 30 000 ms. Set 0 or off to disable.',
            },
            {
              icon: BellOff,
              cmd: '/telegram-settings all on|off',
              desc: 'Toggle every event notification at once. session-end + delegate in one command.',
            },
            {
              icon: RefreshCw,
              cmd: '/telegram-settings poll <seconds>',
              desc: 'Bot polling interval. Range 1–60 seconds. Default 2s. Lower = faster response, higher = less API load.',
            },
            {
              icon: MessageSquare,
              cmd: '/telegram-settings chat <chatId>',
              desc: 'Default chat for notifications. Change without re-running setup. Useful for multi-chat bot setups.',
            },
            {
              icon: Settings2,
              cmd: '/telegram-settings',
              desc: 'Show current settings with the exact command to change each. No argument = read-only status view.',
            },
            {
              icon: Shield,
              cmd: '/telegram-settings test',
              desc: 'Send a test message to verify connectivity, permissions, and that the bot can reach your chat.',
            },
          ].map(({ icon: Icon, cmd, desc }) => (
            <div key={cmd} className="rounded-xl border border-line bg-card p-5">
              <Icon className="size-4 text-brand" />
              <code className="mt-4 block font-mono text-sm font-black text-brand">{cmd}</code>
              <p className="mt-2 text-xs leading-5 text-muted">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ── Approval prompts ────────────────────────────────────────────── */}
      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="04"
            eyebrow="Approvals"
            title="Approve or deny from anywhere. Timeout auto-denies."
            description="The agent posts yes/no prompts with inline keyboard buttons to your Telegram chat. You tap Approve or Deny. If you don't respond within the timeout, the operation is auto-denied."
          />
          <div className="mt-12 grid gap-6 lg:grid-cols-3">
            {[
              {
                icon: CheckCircle,
                title: 'Prompt flow',
                body: 'Agent encounters a gated operation → sends an approval prompt to Telegram with context → you tap Approve/Deny → agent proceeds or blocks. The prompt includes what, why, and risk level.',
              },
              {
                icon: Clock,
                title: 'Timeout & auto-deny',
                body: "Default timeout: 60 seconds. Max: 10 minutes. If you don't respond in time, the operation is auto-denied. No hanging agents, no orphaned prompts.",
              },
              {
                icon: KeyRound,
                title: 'When approvals trigger',
                body: 'Destructive operations (file deletion outside project), deploys to production, config changes that affect security, permission policy modifications. You control the threshold.',
              },
            ].map(({ icon: Icon, title, body }) => (
              <article key={title} className="rounded-2xl border border-line bg-card p-7">
                <Icon className="size-5 text-brand" />
                <h2 className="mt-8 text-xl font-black text-fg">{title}</h2>
                <p className="mt-3 text-sm leading-7 text-muted">{body}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* ── Runtime commands ─────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="05"
          eyebrow="Runtime commands"
          title="Three commands while the bot is running."
          description="When the Telegram plugin is active, three runtime commands are registered. These are separate from the always-available setup and settings commands."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-3">
          {[
            {
              cmd: '/telegram-health',
              alias: '/tgstat /tgs',
              desc: 'Show bot health: polling state, allowlists, notification settings, last message timestamp.',
            },
            {
              cmd: '/send [chat_id] <message>',
              alias: '',
              desc: 'Send a message. Optional numeric chat_id overrides the default. Falls back to configured notifyChatId.',
            },
            {
              cmd: '/chatid',
              alias: '',
              desc: 'Show the configured default notification chat ID. Use this to verify your setup or copy the ID for /send.',
            },
          ].map(({ cmd, alias, desc }) => (
            <div key={cmd} className="rounded-xl border border-line bg-card p-5">
              <code className="font-mono text-sm font-black text-brand">{cmd}</code>
              {alias && (
                <code className="mt-1 block font-mono text-[10px] text-faint">{alias}</code>
              )}
              <p className="mt-2 text-xs leading-5 text-muted">{desc}</p>
            </div>
          ))}
        </div>
      </section>

      <PageNext
        label="Collab debugging"
        title="BugHunter, RefactorPlanner, and Critic"
        body="Three agents run in parallel on your target files and produce a structured verdict."
        href="/collab"
      />
    </>
  );
}
