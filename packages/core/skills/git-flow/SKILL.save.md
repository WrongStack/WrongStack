# Git Workflow (Compact)

<!-- source-version: 2.1.2 -->

## Selection card
- Task: Manage scoped commits, branches and pull requests. / TR: Kapsamlı commit, branch ve pull request yönet.
- Start: Run git status, git branch -vv and git log --oneline -5 to see branch, upstream and uncommitted work before changing anything.
- Finish: The commit, branch or PR exists as intended, nobody else's work was touched, and the final git status is clean or explained.

## Overview

Agents damage repositories in a few repeatable ways: committing files that
belong to someone else, rewriting shared history, destroying uncommitted work,
and bypassing hooks. This skill is the discipline that prevents those, applied
on top of the repository's own conventions.

## Rules

1. Commit, push, or open a pull request only when the user asked for it. Never
   push on your own initiative.
2. Look before you write: check status and both the unstaged and staged diff
   before every commit. Stage explicit paths — never `git add -A` or `git add .`
   in a worktree that may hold someone else's in-progress changes.
3. Follow the repository's conventions. Read recent history and any
   CONTRIBUTING, commitlint, or PR template before choosing a message format or
   branch name.
4. Never bypass hooks or signing (`--no-verify`, `-n`, `--no-gpg-sign`). When a
   hook fails, fix the cause or report it.
5. Inspect before anything destructive — `reset --hard`, `checkout -- <path>`,
   `clean -fd`, `branch -D`, force pushes, rebasing pushed commits. Know what
   would be lost, prefer the non-destructive alternative, and ask when work
   could be lost.
6. Don't rewrite shared history. On a branch others use, add commits or revert.
   On your own pushed branch, `--force-with-lease`, never `--force`.
7. One concern per commit. The message says why; the diff already shows what.

## Detailed workflow

Load the full git-flow skill before relying on its specialized modes,
references or output contracts. Its current SKILL.md is the source of truth;
this compact body does not expand task scope or authorization.

## Before returning

- [ ] Commit, push, or PR happened only because the user asked
- [ ] Staged list reviewed; only this task's files are in it
- [ ] Message matches the repository's convention and explains why
- [ ] No hook bypass; no force push to shared history
- [ ] Anything destructive was inspected first and is recoverable
