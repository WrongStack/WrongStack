# /mode — Session Mode Switcher

## What it does

Switches or views the active session mode. Modes are behavioral presets layered on top of the base system prompt via `DefaultModeStore`.

The built-in modes are organized around a simple trade-off:

- **Token-saving / lite modes** keep scope narrow, output short, and verification focused.
- **Deep / full modes** spend more context on checklists, cross-file reasoning, explanation, and coverage.

## Choosing a mode

| Need | Recommended mode |
|---|---|
| General balanced coding | `default` |
| Lowest-token answers | `brief` |
| Quick changed-file review | `review-lite` |
| Full correctness/security review | `code-reviewer` |
| Quick security triage | `audit-lite` |
| Full security audit | `code-auditor` |
| Quick implementation plan | `plan-lite` |
| Full architecture/design analysis | `architect` |
| Quick bug triage | `debug-lite` |
| Full root-cause investigation | `debugger` |
| One focused regression test | `test-lite` |
| Full QA/test strategy | `tester` |
| Small behavior-preserving cleanup | `refactor-lite` |
| Full refactor/modernization pass | `refactorer` |
| Quick current-data check | `research-lite` |
| Full web research with cross-checking | `research-web` |
| Design-first UI implementation | `ui-design` |
| Explanatory mentor behavior | `teach` |
| Infrastructure/deployment review | `devops` |

## Mode families

### Token-saving / lite

| Mode | Description |
|---|---|
| `brief` | Ultra-compact responses for low-context, high-speed work. |
| `review-lite` | Changed files only; top correctness/security risks. |
| `audit-lite` | Security triage for a small diff or named file. |
| `plan-lite` | 3-6 actionable steps with minimal design debate. |
| `debug-lite` | One hypothesis, nearest evidence, narrow check. |
| `test-lite` | One focused regression or narrow verification target. |
| `refactor-lite` | Small scoped behavior-preserving cleanup. |
| `research-lite` | One search, one authoritative fetch, short answer. |

### Deep / full

| Mode | Description |
|---|---|
| `code-reviewer` | Comprehensive review across contracts, edge cases, lifecycle, errors, and concurrency. |
| `code-auditor` | Security audit with category coverage and exploitability notes. |
| `architect` | Architecture and cross-module contract analysis. |
| `debugger` | Root-cause analysis with traces, logs, assumptions, and verification. |
| `tester` | Coverage, boundaries, isolation, and integration gaps. |
| `devops` | Infrastructure, deployment, observability, and operations. |
| `refactorer` | Modernization/refactor with contract and verification discipline. |
| `ui-design` | Design-first frontend/mobile UI work. |
| `teach` | Mentor-style explanations, mental models, trade-offs, and takeaways. |
| `research-web` | Current-data research with cross-checking and reusable findings. |

## Usage

```text
/mode                 → show current + available modes
/mode brief           → switch to ultra-compact mode
/mode review-lite     → switch to narrow changed-file review
/mode code-reviewer   → switch to full review mode
/mode default         → return to balanced default behavior
```

Active mode is stored in `modeStore` and included in the system prompt by `DefaultSystemPromptBuilder`.

## Code reference

- `packages/cli/src/slash-commands/mode.ts`
- `packages/core/src/types/mode.ts`
- `packages/core/src/models/mode-store.ts`
- `packages/core/instructions/modes/*.md`
- `packages/core/src/core/system-prompt-builder.ts` — mode layer integration
