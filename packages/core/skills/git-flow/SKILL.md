---
name: git-flow
description: |
  Use this skill when proposing, reviewing, or troubleshooting git commits,
  branches, pull requests, or merge strategies in a WrongStack project session.
  Triggers: user mentions "commit", "branch", "PR", "merge", "rebase", "stash", "diff".
version: 1.2.0
---

# Git Workflow — WrongStack

## Overview

Guides commit messages, branch hygiene, PR strategy, and merge decisions. WrongStack uses pnpm workspaces — use `pnpm -r` for recursive commands across packages.

## Rules

1. One concern per commit — never mix logic changes with lockfile updates.
2. Never force-push shared branches — use `--force-with-lease` on own branches only.
3. Always branch from `main` or a stable release tag.
4. Small, frequent commits with clear messages beat large, vague ones.
5. Rebase onto `main` before PR when safe for cleaner history.
6. Delete branches after merge unless shared or releasing.

## Patterns

### Do

```bash
# ✅ Good commit — what and why
fix: correct race condition in token refresh

Retry logic now respects backoff multiplier. Without this,
repeated failures would hammer the provider instead of backing off.

Fix #123

# ✅ Topic branch naming
feat/login
fix/session-leak
refactor/auth-layer

# ✅ Feature branch → rebase → fast-forward merge
git rebase main && git merge --ff-only feature
```

### Don't

```bash
# ❌ Bad — what, not why
git commit -m "fix: fixed bug"

# ❌ Bad — WIP commit left in main
git commit -m "WIP"

# ❌ Bad — force-push to shared branch
git push --force origin main

# ❌ Bad — mega-commit across 15 packages
git commit -m "Update stuff"
```

## Commit messages

Format: `type: short description`

Types: `fix`, `feat`, `docs`, `refactor`, `test`, `chore`, `perf`, `ci`

Rules:
- Subject ≤ 72 chars, imperative mood, no trailing period
- Body: explain **why**, not what (the diff shows what)
- Reference issues: `Fix #123` or `Closes GH-456`

```
# Good
fix: correct race condition in token refresh
Retry logic now respects backoff multiplier. Without this,
repeated failures would hammer the provider instead of backing off.

# Bad — what, not why
fix: fixed bug
```

## Branch strategy

- One topic per branch: `feat/login`, `fix/session-leak`, `refactor/auth-layer`
- Delete branches after merge (unless shared/releasing)
- Rebase onto `main` before PR when safe (cleaner history)
- Never `git push --force` to shared branches — use `--force-with-lease`

## Safety rules

| Action | Safe? | Rule |
|--------|-------|------|
| `push --force` to own branch | ✅ | `--force-with-lease` preferred |
| `push --force` to shared branch | ❌ | Always use PR + merge |
| `reset --hard` with uncommitted work | ❌ | `git stash` first |
| `amend` a pushed commit | ❌ | It rewrites shared history |
| `merge` vs `rebase` | Context | Rebase for feature branches; merge for PRs |

## Pull requests

- Title: same format as commit messages
- Body: link to issue, describe tradeoffs, list changed files
- Keep PRs small: one reviewable concern per PR
- Self-review diff before requesting review

## Merge strategies

```
# Fast-forward merge (clean topic branch)
git checkout feature && git merge --ff-only main

# Merge commit (preserves branch history)
git merge --no-ff feature

# Rebase and fast-forward (clean linear history)
git rebase main && git merge --ff-only feature
```

## WrongStack-specific notes

- WrongStack uses `pnpm` workspaces — `git status` may show many modified files across packages
- Use `pnpm -r` for recursive commands across packages
- Check `pnpm-lock.yaml` changes — don't merge lockfile updates with unrelated changes
- When in doubt: small, frequent commits with clear messages beat large, vague ones

## Anti-patterns

- **Mega-commits**: "Update stuff" across 15 packages — split it
- **WIP commits left in main**: Use `git stash` or a feature branch, not a commit message like "WIP"
- **Committing lockfile with logic changes**: Keep them separate for easier rollbacks
- **Branching from branches**: Always branch from `main` or a stable release tag

## Output format

```
## Git Workflow Report — <task>

### Changes Summary
[What files changed, how many commits, what the impact is]

### Recommended Actions
1. Create branch `feature-name` from `main`
2. Commit changes with conventional commit format
3. Open PR with description linking to issue

<nextsteps>
1. Create a branch fix/session-leak, commit the token refresh fix, and push it
</nextsteps>

Open a PR at GitHub linking to issue #123 with the commit message describing the fix.
```

## Skills in scope

- `refactor-planner` — when a refactor involves multiple git-managed changes
- `multi-agent` — for fleet-wide version audits across packages
- `bug-hunter` — for spotting bugs at commit time before they reach main
- `output-standards` — for standardized `<nextsteps>` formatting
