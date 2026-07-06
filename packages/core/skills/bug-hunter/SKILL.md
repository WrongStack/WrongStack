---
name: bug-hunter
description: |
  Use this skill when scanning source code for bugs, anti-patterns, code smells,
  or quality issues in a WrongStack project. Triggers: user says "bug", "bug hunt",
  "scan for issues", "find problems", "anti-pattern", "code smell", "static analysis".
version: 1.2.0
---

# Bug Hunter — WrongStack

Scans code for bugs and code smells. Outputs a prioritized hit list with file:line references.

## Overview

Grep/read across target files to surface bugs, anti-patterns, and quality issues. Classifies by severity (critical/high/medium/low) and reports with file:line + fix suggestion.

## Rules

1. Always include a `file:line` you have actually read — verify the line exists; never invent, guess, or extrapolate a reference. No line reference = can't be fixed.
2. Never scan `node_modules` — waste of time, false positives.
3. Don't report style issues as bugs — those are lint findings.
4. If >30% of findings are noise, note the false positive rate in the report.
5. Don't flag deprecated APIs without severity — some deprecations are acceptable.
6. Sort output: critical > high > medium > low.

## Workflow

```
1. Scope:  Accept file/dir globs or explicit paths
2. Scan:   grep/read across target files
3. Classify: Categorize by type and severity
4. Rank:   Sort: critical > high > medium > low
5. Report: Markdown with fix suggestions
```

## Severity levels

| Level | Meaning | Action |
|-------|---------|--------|
| **Critical** | Security breach, data loss, crash | Fix immediately |
| **High** | Logic bug, race condition, memory leak | Fix before release |
| **Medium** | Error handling gap, type unsafety | Fix soon |
| **Low** | Style, minor code smell | Consider fixing |

## Patterns

### Do

```typescript
// ✅ FIXED — use textContent instead of innerHTML
element.textContent = userInput;

// ✅ FIXED — parameterized query
db.query("SELECT * FROM users WHERE id = $1", [userId]);

// ✅ FIXED — proper await with catch
await fetchData().catch(err => console.error(err));

// ✅ FIXED — execFile with args array
execFile('echo', [userInput], { signal: AbortSignal.timeout(5000) });
```

### Don't

```typescript
// ❌ CRITICAL — hardcoded API key
const apiKey = "sk-abc123xyz789...";

// ❌ HIGH — innerHTML XSS
element.innerHTML = userInput;

// ❌ HIGH — unhandled promise (then without catch)
fetchData().then(processData);

// ❌ HIGH — shell injection
exec(`echo ${userInput}`);

// ❌ HIGH — unsafe any
const data: any = response.json();
```

### Bug patterns to find

| Pattern | Regex hint | Severity |
|---------|------------|----------|
| Uncaught promise | `\.then\(` without `.catch` | high |
| Event listener leak | `on(` without `off/removeListener` | high |
| Hardcoded secret | `[A-Za-z0-9/+=]{40}` in config or code | critical |
| unsafe any | `: any\b` or `as any` | medium |
| innerHTML assignment | `innerHTML\s*=` | high |
| Missing await | `await` not used on async call | high |
| Unhandled rejection | `process.on('unhandledRejection'` | medium |
| SQL concatenation | `"SELECT * FROM " + table` | critical |
| Shell injection | `exec(\`cmd ${input}\`)` | critical |

## Anti-patterns

- **Don't scan `node_modules`** — waste of time, false positives
- **Don't report without file:line** — useless for fixing
- **Don't ignore false positive rate** — if >30% of findings are noise, note it
- **Don't report style issues as bugs** — those are lint findings
- **Don't flag deprecated without severity** — some deprecations are fine

## Output format

```
## Bug Hunt Report — <scope>

### Critical (must fix)
1. [SHELL-INJ] `tools/shell.ts:42` — template literal in exec()
   `exec(\`echo ${userInput}\`)` → use execFile with args array
2. [SECRET] `lib/config.ts:8` — API key hardcoded

### High
3. [MEMORY] `tools/pool.ts:89` — event listener never removed
4. [TYPE] `core/agent.ts:103` — unsafe `any` cast

### Summary
| Severity | Count |
|----------|-------|
| Critical | 2 |
| High     | 4 |
| Medium   | 7 |
| Low      | 3 |

Total: 16 findings in 12 files

<nextsteps>
1. Fix the shell injection in tools/shell.ts:42
2. Fix the hardcoded API key in lib/config.ts:8
3. Fix the memory leak in tools/pool.ts:89
4. Fix the unsafe any cast in core/agent.ts:103
</nextsteps>
```

## Skills in scope

- `security-scanner` — for hardcoded secrets and injection vectors
- `refactor-planner` — for fixing findings across multiple files
- `typescript-strict` — for TypeScript type safety rules
- `output-standards` — for standardized `<nextsteps>` formatting
