import { AlertTriangle, ArrowDown, Check, EyeOff, ShieldCheck } from 'lucide-react';
import { ExternalDoc, PageHero, PageNext, SectionIntro } from '@/components/site/primitives';
import { securityFacts, securityLayers } from '@/data/content';

export function SecurityPage() {
  return (
    <>
      <PageHero
        index="08"
        eyebrow="Security"
        title={
          <>
            Assume the agent
            <br />
            <span className="text-brand-2">can be wrong.</span>
          </>
        }
        description="WrongStack treats model output as a proposal, repository configuration as untrusted input and every mutation as a policy decision. Autonomy changes speed, not the trust model."
        aside={<ExternalDoc path="SECURITY.md">Read the full security policy</ExternalDoc>}
      />

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="01"
          eyebrow="Defense in depth"
          title="Five gates between intent and side effect."
          description="No single check carries the whole trust model. Capabilities narrow what exists; policy decides what runs; runtime boundaries constrain how it runs; audit records what happened."
        />
        <div className="mt-14 grid gap-2">
          {securityLayers.map((layer, index) => (
            <div key={layer.number}>
              <article className="grid gap-5 rounded-2xl border border-line bg-card p-6 sm:grid-cols-[60px_220px_1fr] sm:items-center sm:p-7">
                <span className="grid size-12 place-items-center rounded-full border border-line bg-bg font-mono text-xs font-black text-brand">
                  {layer.number}
                </span>
                <div className="flex items-center gap-3">
                  <layer.icon className="size-4 text-faint" />
                  <h2 className="font-black text-fg">{layer.title}</h2>
                </div>
                <p className="text-sm leading-7 text-muted">{layer.body}</p>
              </article>
              {index < securityLayers.length - 1 && (
                <ArrowDown className="mx-auto my-1 size-4 text-faint" />
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-line bg-surface">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <SectionIntro
            index="02"
            eyebrow="Permission decision"
            title="YOLO skips confirmation. It does not erase denial."
            description="Tool metadata, hook outcomes, trust rules and runtime danger detection all contribute to a final permission decision."
          />
          <div className="mt-12 grid gap-6 lg:grid-cols-[1fr_.68fr]">
            <div className="overflow-hidden rounded-2xl border border-line bg-card">
              {[
                ['Tool declares permission', 'auto · confirm · deny'],
                ['PreToolUse hooks run', 'allow · mutate · deny'],
                ['Final input is validated', 'JSON Schema + safe coercion'],
                ['Policy evaluates context', 'trust rules · paths · danger'],
                ['Operator decides if needed', 'once · always · deny'],
              ].map(([step, detail], index) => (
                <div
                  key={step}
                  className="grid grid-cols-[38px_1fr_auto] items-center gap-3 border-b border-line p-5 last:border-b-0"
                >
                  <span className="font-mono text-xs font-black text-brand-2">0{index + 1}</span>
                  <strong className="text-sm text-fg">{step}</strong>
                  <code className="hidden font-mono text-xs text-faint sm:block">{detail}</code>
                </div>
              ))}
            </div>
            <div className="rounded-2xl border border-brand/20 bg-brand/5 p-6 sm:p-8">
              <AlertTriangle className="size-6 text-brand" />
              <h2 className="mt-6 text-2xl font-black tracking-[-0.04em] text-fg">
                What YOLO really means
              </h2>
              <p className="mt-4 text-sm leading-7 text-muted">
                YOLO auto-approves calls that the active policy permits. A hook denial, explicit
                deny rule or unavailable capability still blocks the call.
              </p>
              <code className="mt-6 block rounded-lg border border-brand/15 bg-card px-4 py-3 font-mono text-xs text-brand">
                --yolo ≠ bypass security policy
              </code>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="03"
          eyebrow="Data and network"
          title="Local first, selectively encrypted and redacted."
        />
        <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-line bg-line lg:grid-cols-3">
          {securityFacts.map((fact) => (
            <article key={fact.title} className="bg-card p-7">
              <fact.icon className="size-5 text-brand" />
              <h2 className="mt-8 text-xl font-black tracking-[-0.035em] text-fg">{fact.title}</h2>
              <p className="mt-3 text-sm leading-7 text-muted">{fact.body}</p>
            </article>
          ))}
        </div>
        <div className="mt-6 grid gap-5 lg:grid-cols-2">
          <div className="rounded-2xl border border-line bg-card p-6">
            <div className="flex items-center gap-3">
              <EyeOff className="size-5 text-brand" />
              <h2 className="font-black text-fg">Telemetry is scrubbed</h2>
            </div>
            <p className="mt-3 text-sm leading-7 text-muted">
              WebUI and HQ preview paths redact and truncate known credential shapes. Pattern-based
              scrubbing is not a proof against arbitrary secrets, and local full-audit records may
              retain raw tool data.
            </p>
          </div>
          <div className="rounded-2xl border border-line bg-card p-6">
            <div className="flex items-center gap-3">
              <ShieldCheck className="size-5 text-emerald-500" />
              <h2 className="font-black text-fg">Remote access needs a trusted boundary</h2>
            </div>
            <p className="mt-3 text-sm leading-7 text-muted">
              WebUI, mailbox and MCP surfaces bind loopback by default. Mailbox bridge tokens are
              bearer capabilities, not agent identities. HQ auth now fails closed on corrupt or
              unreadable auth files; missing files and explicit empty token lists remain intentional
              open/bootstrap modes. Put a trusted proxy in front of any non-loopback exposure.
            </p>
          </div>
        </div>
      </section>

      <section className="border-t border-line bg-ink text-white">
        <div className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10">
          <div className="grid gap-8 lg:grid-cols-[.65fr_1fr]">
            <div>
              <span className="font-mono text-xs font-black uppercase tracking-[0.2em] text-brand">
                Repository config
              </span>
              <h2 className="mt-5 text-4xl font-black tracking-[-0.025em]">Clone safely.</h2>
            </div>
            <div>
              <p className="text-lg leading-8 text-zinc-400">
                The allow-list strips provider endpoints, keys, MCP servers, hooks, plugins, sync,
                YOLO, extensions, HQ, ACP and fleet settings from checked-in config. Nested
                dangerous fields are stripped too. This does not sandbox trusted user config: shell
                and HTTP hooks remain privileged operator code.
              </p>
              <div className="mt-6 flex items-center gap-3 text-sm font-semibold text-emerald-400">
                <Check className="size-4" /> New config fields are denied until classified
                explicitly.
              </div>
              <div className="mt-6">
                <ExternalDoc path="docs/configuration.md#config-file-locations">
                  Review configuration boundaries
                </ExternalDoc>
              </div>
            </div>
          </div>
        </div>
      </section>
      <section className="mx-auto max-w-[1380px] px-4 py-20 sm:px-6 sm:py-28 lg:px-10 lg:py-36">
        <SectionIntro
          index="05"
          eyebrow="Secret vault"
          title="Encrypted at rest. Decrypted on demand."
          description="SecretVault stores credentials (API keys, tokens, passwords) in an encrypted file. New secrets written from the environment are encrypted before landing on disk. The vault walks config fields matching known key patterns for auto-encryption."
        />
        <div className="mt-12 grid gap-4 sm:grid-cols-3">
          {[
            {
              title: 'Encryption',
              body: 'scrypt-based key derivation with random salt. Secrets are opaque blobs — never plaintext on disk.',
            },
            {
              title: 'Auto-detection',
              body: 'Field names matching secret patterns (token, key, secret, password) are auto-encrypted on write.',
            },
            {
              title: 'Scrubbing',
              body: 'SecretScrubber removes credential-like patterns from tool output, session logs, and telemetry before they leave the agent.',
            },
          ].map(({ title, body }) => (
            <div key={title} className="rounded-xl border border-line bg-card p-5">
              <h3 className="font-black text-sm text-fg">{title}</h3>
              <p className="mt-2 text-xs leading-5 text-muted">{body}</p>
            </div>
          ))}
        </div>
      </section>
      <PageNext
        label="Home"
        title="Put the system to work"
        body="Return to the overview or install WrongStack locally and start with your own repository."
        href="/"
      />
    </>
  );
}
