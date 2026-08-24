# 02 — Tool Usage

Examples exercising WrongStack's built-in tool registry. The full set currently
contains 70 tools (including 16 `browser_*` tools); token-saving modes may expose
a smaller tier for a session. Run `wrongstack tools` for the active registry.

`wrongstack tools` lists everything currently registered for the active
session.

## File editing

```bash
wrongstack "rename the function getData to fetchData everywhere in src/"
wrongstack "add error handling to the try/catch block in src/api.ts"
wrongstack "convert var declarations to const/let across src/utils/"
```

## Code search

```bash
wrongstack "find every TODO comment in the codebase, grouped by file"
wrongstack "which files import from @wrongstack/core?"
wrongstack "find unused exports starting from src/index.ts"
```

## Git operations

```bash
wrongstack "summarize the last 5 commits"
wrongstack "create a conventional commit for the currently staged changes"
wrongstack "show me the diff between main and the current branch"
```

There's also a `/commit` slash command that drafts the message via the
configured LLM and a `/gitcheck` that runs a quick repo-state audit
before you commit.

## Running tests

```bash
wrongstack "run the test suite and fix any failures"
wrongstack "add a test for the parseArgs function in arg-parser.ts"
wrongstack "run tests for the permission-policy module only"
```

The `test` tool auto-detects Vitest / Jest / Mocha.

## Project scaffolding

```bash
wrongstack "create a new TypeScript utility module for string manipulation"
wrongstack "generate a GitHub Actions workflow for lint + typecheck + test on PRs"
wrongstack "scaffold a new pnpm workspace package under packages/my-plugin"
```

## Dependency management

```bash
wrongstack "check for outdated dependencies and group by major/minor/patch risk"
wrongstack "run npm audit and explain the top 3 advisories"
wrongstack "add vitest as a dev dependency"
```

## Inspect what's available

```bash
# CLI subcommands
wrongstack tools                   # tools registered for the active session
wrongstack skills                  # skills discovered in the project + user dirs
wrongstack diag                    # provider / token / path diagnostics
wrongstack usage                   # token + cost totals across sessions

# In-session slash commands
/tools                              # same as `wrongstack tools` but live
/skill                              # list skills
/diag                               # session diagnostics
```
