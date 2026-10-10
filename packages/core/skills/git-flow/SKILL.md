---
name: git-flow
description: |
  Use this skill when committing, branching, opening a pull request, resolving conflicts, or recovering from a git mistake in any repository.
  Triggers: user mentions "commit", "branch", "PR", "pull request", "merge", "rebase", "conflict", "stash", "cherry-pick", "revert", "bisect", "reflog", "force push".
version: 2.1.1
required-capabilities: [version-control.manage]
required-tools: []
trigger: "Use this skill when committing, branching, opening a pull request, resolving conflicts, or recovering from a git mistake in any repository."
metadata:
  routing-group: workflow
---

# Git Workflow

## Selection card
- Task: Manage scoped commits, branches and pull requests.
- Start: Identify the requested artifact, repository owner and acceptance criteria.
- Finish: apply the acceptance checks below; report observed results and unresolved constraints.

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

## Before a commit

```bash
git status --short
git diff --stat           # unstaged
git diff --staged         # exactly what will be committed
git log --oneline -15     # the message style to match
```

Confirm the staged list contains only files changed for this task. Lockfiles,
generated files, and formatting churn go in only when they belong to the change.

## Messages

Match the existing style. When the repository has none:

```text
fix(auth): refresh the token before it expires, not after

Requests made in the last 30 s of a token's life failed with 401 and were
retried blindly. Refreshing at 80% of the lifetime removes the window.

Refs #123
```

Subject: imperative, at most 72 characters, no trailing period. Body: the
reason, the trade-off, and anything a reviewer can't see in the diff.

## Conflicts

1. List conflicted files and read both sides before editing.
2. Resolve by intent, not by taking one side wholesale; keep both changes when
   both are valid.
3. Remove every conflict marker, then build and run the relevant tests before
   staging and continuing.
4. When resolving needs a product decision, stop and ask. `git merge --abort` or
   `git rebase --abort` returns to the starting point.

## Recovery

| Situation | Recovery |
|---|---|
| Commit lost after a reset or rebase | `git reflog`, then `git branch rescue <sha>` |
| Committed to the wrong branch (not pushed) | `git branch <new-branch>`, then move the wrong branch back |
| Need to undo a pushed commit | `git revert <sha>` |
| Uncommitted work at risk | `git stash push -m "<reason>"` (add `-u` for untracked files) |
| Find the commit that broke something | `git bisect start <bad> <good>`, then `git bisect run <test command>` |

## Safety table

| Action | Safe? | Do instead |
|---|---|---|
| Force push to a shared branch | ❌ | Revert or add a commit |
| `--force-with-lease` to your own branch | ✅ | — |
| `reset --hard` with uncommitted work | ❌ | Stash or commit first |
| Amend a pushed commit | ❌ | Follow-up commit |
| `git add -A` in a shared worktree | ❌ | Stage explicit paths |
| Skipping hooks | ❌ | Fix what the hook reports |

## Pull requests

- Title in commit-message style. Body: what changed, why, how it was verified,
  and the risks.
- One reviewable concern per pull request; read the full diff yourself first.
- To merge a clean topic branch without a merge commit:
  `git checkout main && git merge --ff-only feature`.

## Anti-patterns

- **"Update stuff" commits** spanning unrelated changes — split them.
- **Committing everything the worktree contains** instead of the task's files.
- **Resolving a conflict by deleting the other side** without reading it.
- **Treating a failing hook as an obstacle** rather than a finding.

## Before returning

- [ ] Commit, push, or PR happened only because the user asked
- [ ] Staged list reviewed; only this task's files are in it
- [ ] Message matches the repository's convention and explains why
- [ ] No hook bypass; no force push to shared history
- [ ] Anything destructive was inspected first and is recoverable

## Exact state and shared index

Recheck the index and owned paths immediately before a commit. Hooks may produce
additional artifacts: inspect them and verify the resulting commit after hooks
finish. In a shared checkout, an alternate index can isolate authorized paths
without consuming another writer's staged work; it still needs the normal hooks.
Use structured PR input or a body file to preserve newlines. Pin the PR head
and required CI results before any authorized merge.

## Skills in scope

- `refactor-planner` — for sequencing a large change into reviewable commits
- `bug-hunter` — for a last pass over the diff before committing
- `output-standards` — for the `<nextsteps>` shape in the final report
