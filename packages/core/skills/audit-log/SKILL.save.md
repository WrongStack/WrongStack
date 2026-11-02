# Audit Log — WrongStack session journals (Compact)

<!-- source-version: 2.1.2 -->

## Selection card
- Task: Inspect session journal evidence and provenance. / TR: Oturum journal kanıtı ve kaynağını incele.
- Start: Locate the journal files for the session in question and confirm their time range and session id.
- Finish: The report explains what happened with counts and quoted journal evidence: tool failures, token and cache numbers, compactions, delegations and loops.

## Overview

Every WrongStack session is journaled as JSONL: one event per line, in order.
The journal is the ground truth for what the agent did, what it cost, and where
it went wrong. Analyze it from the file, report numbers that trace back to
specific events, and never summarize a session you did not parse.

## Rules

1. Parse the journal; don't infer from memory, the UI, or the session title.
2. Scope every figure: one session, or an aggregate labelled per session.
3. Cite evidence — event type, timestamp, tool name, tool call id — for every
   finding.
4. Stream the file line by line; journals can be hundreds of megabytes. Skip
   and count malformed lines instead of aborting.
5. Treat content as sensitive. `user_input`, tool inputs, and tool results can
   hold secrets and personal data; quote only what a finding needs, redacted.
6. The analysis is read-only. Never edit, truncate, or rewrite a journal.

## Detailed workflow

Load the full audit-log skill before relying on its specialized modes,
references or output contracts. Its current SKILL.md is the source of truth;
this compact body does not expand task scope or authorization.

## Before returning

- [ ] Journal parsed from disk; malformed lines counted, not fatal
- [ ] Every finding cites event types, times, and ids
- [ ] Tool failures joined by id; token and cache figures from `usage`
- [ ] Coverage stated (lines parsed, subagent transcripts included or not)
- [ ] Nothing sensitive quoted unredacted; journal untouched
