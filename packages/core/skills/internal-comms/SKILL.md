---
name: internal-comms
description: "Internal engineering comms: status reports, live incident updates, blameless postmortems, launch and deprecation notices, escalations. Use when writing a weekly or project status update, an incident update or postmortem, a release, change or deprecation announcement, a leadership decision memo, or an escalation asking for help. Not for RFCs, design docs or ADRs (use doc-coauthoring)."
version: 1.2.2
required-capabilities: [filesystem.read, filesystem.write]
required-tools: []
optional-capabilities: [verification.run, web.research]
trigger: "Use when a request asks for a status update, incident update, postmortem, announcement, changelog note, leadership brief or escalation message."
metadata:
  routing-group: workflow
---

# Internal Comms

## Selection card
- Task: Write internal engineering messages that a busy reader can act on from the first two lines.
- Start: Identify the message type, the audience and the decision or action expected of them, and the channel (chat, email, doc); collect the facts: PRs, tickets, dashboards, alert and log timestamps.
- Finish: the first line states the situation and the ask, every fact links to a source, times are unambiguous, owners and dates are attached to every action, and the draft is returned for the user to send.

## Overview

Internal comms succeed when a busy reader can act from the first two lines: lead with what changed and what you need, keep every fact checkable, and fit the format to the channel.
Formats below were reviewed 2026-11-02 against common engineering practice; the organization's own templates and severity definitions take precedence.

## Rules

1. Bottom line up front: the first line carries the state and the ask ("On track for 14 Nov; need a decision on refund scope by Wed"). In chat the first line is the preview; in email the subject is.
2. Write for the reader's decision: leadership needs impact, risk and the ask; engineers need what changes for them; customer-facing teams need what to tell customers. Split the message when audiences diverge.
3. Make facts checkable: link the PR, ticket, dashboard or runbook; give numbers with units and time windows; write times in UTC with a date (add local time for regional audiences); never round a bad number into a good one.
4. Earn the status color: Green means on track with no help needed, Amber means at risk with a plan or ask, Red means it will miss without intervention. Report the change since the last update, and write the word, not only a colored dot.
5. Incidents have two genres. Live updates are short, on a promised cadence (impact, what is known, what is being done, next update time) and never speculate on cause. Postmortems are blameless: system conditions and decisions, several contributing factors, detection and response gaps, and owned, dated action items.
6. Change and deprecation notices answer: what changes, who is affected, when, what they must do, where to get help, and what happens if they do nothing. Send early and remind before the deadline.
7. Escalations open with the ask, then why now, the options with a recommendation, the deadline and the cost of no decision. Escalate with data, not blame.
8. Keep broad channels safe: no customer personal data, credentials, unfixed vulnerability details or named blame.

## First moves by situation

| Request | First moves |
|---|---|
| Weekly or project status | Pull merged PRs, moved tickets, metric deltas and dates; compare with last update's plan; write the headline, then progress, plans and problems |
| Live incident update | Status (Investigating, Identified, Monitoring, Resolved), impact, current action, next update time in UTC |
| Postmortem | Timeline from alerts, logs and chat with UTC timestamps; quantified impact; contributing factors; what went well; action items typed prevent, detect or mitigate |
| Launch announcement | What shipped and why, who benefits, how to use it, known limits, links, feedback channel |
| Deprecation or breaking change | Dated timeline, affected consumers, migration steps, support contact, scheduled reminders |
| Leadership brief or decision memo | One page: situation, options, recommendation, cost and risk, ask, deadline |
| Escalation | Ask in the first line; three bullets of context; options; decision deadline |
| Bad news | Lead with it; impact; what is being done; what is needed; no burying under progress |

## Patterns and pitfalls

- **Activity instead of outcome** — "worked on caching" becomes "p95 checkout latency 120 ms to 18 ms after the cache change (PR link)".
- **Walls of text in chat** — a short headline message with details in the thread; long content goes to a doc linked from the message.
- **Ambiguous time** — "next Friday" and "EOD" become "Fri 14 Nov, 17:00 UTC".
- **Vague is not blameless** — "mistakes were made" hides the system; describe the actions and conditions specifically without assigning fault.
- **Single root cause** — complex incidents have several contributing factors; "human error" is where analysis starts, not where it ends.
- **Orphan action items** — items without owner, due date and ticket do not get done; track them where work is tracked.
- **Severity inflation** — use the organization's severity definitions; overclaiming erodes trust in the next page.
- **Missed update** — silence is worse than "no new information; next update 15:30 UTC".
- **Watermelon status** — green on the outside, red inside; if the plan slipped, the color changes.

## Templates

```markdown
**Payments migration status, 2026-11-07: Amber**
On track for the 14 Nov beta except refunds; need a decision on refund API scope by Wed 12 Nov.
- Progress: <outcome with link>
- Next week: <committed items>
- Problems and asks: <blocker, owner, what unblocks it, by when>
```

```text
[Investigating] Checkout errors for EU customers (14:20 UTC)
Impact: about 12% of EU checkout requests failing since 13:55 UTC; other regions normal.
Doing: rolled back deploy 4821; watching the error rate.
Next update: 14:50 UTC, or sooner if status changes.
```

Postmortem headings: Summary; Impact (who, how many, how long, money or data); Timeline (UTC, with sources); Contributing factors; Detection and response; What went well; Action items (action, type, owner, due date, ticket).

## Workflow

1. Classify the message, the audience, their expected action and the channel.
2. Gather facts from sources (PRs, tickets, dashboards, alerts, logs, chat) and note the time each number was read.
3. Write the headline line first; then the body in the matching template; then cut.
4. Check every fact, link, time and owner against its source.
5. Run the reader test and fix what a cold reader could not answer.
6. Return the draft for the user to send; never post on their behalf without explicit permission.

## Proof

- Reader test: give only the message to a fresh reader (or a fresh subagent with no context) and ask "What is the state? What do you need from me? By when?"; all three answers must match the intent.
- Facts: every link opens and every number matches its source at the stated time; all times carry a date and a zone.
- Postmortem: each action item has an owner, due date and ticket; each timeline entry cites an alert, log or message.
- Length: a chat headline fits in the preview (about 150 characters); a status update fits about 200 words before details.

## Stop and ask

- Posting, emailing or sending on the user's behalf.
- Security incidents, legal or regulatory exposure, or any customer-facing statement.
- Attributing fault to named people, or personnel matters.
- Numbers or timelines that cannot be verified from a source.

## Before returning

- [ ] First line states the situation and the ask; subject or headline fits the preview
- [ ] Format matches the message type and the organization's template if one exists
- [ ] Every claim links to a PR, ticket, dashboard or log; numbers carry units and time windows
- [ ] Times in UTC with dates; status color justified by the plan and written as a word
- [ ] Actions have owners, due dates and tickets
- [ ] Blameless, specific language; no personal data, secrets or unfixed vulnerability details
- [ ] Reader test passed; draft returned unsent

## Skills in scope

- incident-response — live triage, mitigation and postmortem evidence collection.
- doc-coauthoring — RFCs, ADRs and design documents behind a decision memo.
- release-rollback — deployment communication and rollback coordination.
- observability — dashboards and queries that back the numbers in updates.
