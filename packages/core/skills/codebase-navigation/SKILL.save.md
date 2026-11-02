# Codebase Navigation (Compact)

<!-- source-version: 1.1.2 -->

## Selection card
- Task: Locate repository entry points and owning modules. / TR: Depo giriş noktalarını ve sorumlu modülleri bul.
- Start: State the question (where, how, what depends on it) and query the codebase index tools before opening files one by one.
- Finish: The answer names the files, symbols and call path with file:line references, and says what was not checked.

## Overview

Reading files top to bottom is the slowest way to understand code and the
fastest way to fill the context window. Navigate from structure to detail:
orient, locate, trace, then read only the lines that matter. WrongStack's
codebase index turns most of these steps into a single call; without it, the
same moves work with glob, grep, and ranged reads.

## Rules

1. Orient before diving: project manifests, README / AGENTS / CONTRIBUTING, the
   top-level layout, entry points, and where tests live.
2. Search by meaning when you don't know the name, by name when you do, and by
   exact text for strings, config keys, and error messages.
3. Read skeletons before bodies — signatures, types, and exports carry most of a
   module's contract.
4. Once you know the line, read that range, not the whole file.
5. Trace relationships through the reference graph (callers, callees, imports)
   instead of guessing from file names.
6. Don't conclude absence from one empty search. Retry with another query, a
   wider scope, or exact grep — dynamic registration, string dispatch, and
   generated code are invisible to indexes.
7. Keep a running map of key files, entry points, and traced flows so nothing
   gets read twice.
8. Stop navigating as soon as you have located the authoritative files, symbols,
   and immediate callers needed to answer the question or make the change — do
   not keep reading tangential modules once the target flow is clear.

## Detailed workflow

Load the full codebase-navigation skill before relying on its specialized modes,
references or output contracts. Its current SKILL.md is the source of truth;
this compact body does not expand task scope or authorization.

## Before returning

- [ ] Claims about location and flow cite file:line
- [ ] Absence claims backed by more than one search method
- [ ] Untraced links in a flow labelled as such
