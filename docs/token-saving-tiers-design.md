# Multi-Tier Token Saving Mode — Design Document

## Problem Statement

The current `tokenSavingMode: boolean` is binary — it either applies maximum reduction or none. This forces an all-or-nothing trade-off: maximum savings may degrade the model's ability to handle complex tasks, while full mode wastes tokens on elements that could safely be simplified.

A better model is a **sliding scale with named tiers**, where each tier specifies which elements to reduce and by how much. The user picks a tier that matches their use case.

---

## Proposed Solution

Replace `boolean` with a string union type for `tokenSavingMode`:

```typescript
type TokenSavingTier = 
  | 'off'        // Full mode — no reduction
  | 'minimal'    // Maximum savings — essential tools + minimal guidance
  | 'light'      // Light savings — core tools + common patterns
  | 'medium'     // Moderate savings — extended tools + some guidance
  | 'aggressive'; // Maximum savings before tools become unusable
```

### Tier Comparison Matrix

| Element | off | minimal | light | medium | aggressive |
|---------|-----|---------|-------|--------|------------|
| **Tools** | All 38 | TIER1 (10) | TIER1 (10) | TIER1+TIER2 (26) | TIER1+TIER2+TIER3 (36, minus `task`/`setWorkingDir`) |
| **Tool desc length** | 80 chars | 40 chars | 50 chars | 60 chars | 70 chars |
| **Common patterns** | ✅ | ❌ | ✅ | ✅ | ❌ |
| **Delegation guidance** | Full | ❌ | Minimal | Minimal | Minimal |
| **Mailbox guidance** | Full | ❌ | Minimal | Minimal | Minimal |
| **Context management** | ✅ | ❌ | ❌ | Minimal | ✅ (carve-out) |
| **Commit hygiene** | ✅ | ❌ | ❌ | ✅ | ✅ (carve-out) |
| **MCP guidance** | Full | Minimal | Minimal | Full | Minimal |
| **Skill bodies** | Full | Compact | Compact | Compact | Compact |
| **Environment details** | Full | Git+date only | +platform | +languages | +capabilities |
| **Online agents** | Full list | Count only | Count only | Full list | Full list |
| **Memory injection** | 8 items | 3 items | 5 items | 8 items | 8 items |

> **Memory tools** (`remember`, `forget`, `searchMemory`, `relatedMemory`) are **not** part of
> the tier filter — they are registered independently based on `features.memory`
> (`packages/cli/src/wiring/tools.ts:118-123`). Setting `features.memory: false` removes
> them at every tier; setting it to `true` registers them at every tier. The original
> design proposal that "memory tools are always included in minimal+ tiers" was not
> implemented.

### Estimated Token Savings by Tier

Empirical measurements (project heuristic 3.5 chars/token, run via
`packages/cli/tests/token-saving-measurement.test.ts`):

| Tier | Measured Δ vs `off` | Use Case |
|------|---------------------|----------|
| `off` | 0 tokens | Complex tasks, multi-file refactors |
| `minimal` | ~2,500–2,700 tokens | Quick fixes, single-file edits |
| `light` | ~2,300–2,400 tokens | Standard development, most tasks |
| `medium` | ~1,400–1,500 tokens | When extra tools are needed |
| `aggressive` | ~1,000 tokens | Many tools, trimmed prompt |

**Savings are not monotonic across tiers.** The five tiers optimize along
two axes (tool count × guidance detail), so the size ordering is
`off > aggressive > medium > light ≈ minimal`, not `off > medium > light >
aggressive > minimal`. Pick the tier that matches your use case rather
than the one with the largest savings number:

- **Fewer tools + lots of guidance trimmed** — `minimal`, `light`. TIER1 only.
- **Fewer tools + full guidance** — `medium`. TIER1+TIER2.
- **Many tools + compact guidance** — `aggressive`. TIER1+TIER2+most-TIER3.

The original design intent for `aggressive` was "~4-5k tokens saved by
removing tools as well as guidance", but that would require cutting the
tool count from 35 to ~22 — making `aggressive` indistinguishable from a
stricter version of `medium`. The implementation chose to keep the wider
tool set (44 tools including meta-tools and one-off generators) and only
compact the prompt's guidance sections. Users who want maximum savings
should pick `minimal` (2.5k saved) or `light` (2.4k saved); users who want
many tools under a tight budget should pick `aggressive` (1k saved,
44 tools).

`aggressive` skips the same guidance sections as `minimal`/`light`
(Common Patterns, Delegation, Mailbox, MCP). Context Management and
Commit Hygiene remain at `aggressive` because the former is most useful
when context is the bottleneck and the latter is a small (~200 token)
safety net. The remaining ~1,500 tokens of prompt content vs `off` is
the tool surface area (44 tools at `aggressive` vs 25 at `medium`).

If a future design wants a 6th tier that combines `aggressive`'s compact
guidance with `minimal`'s narrow tool set, the cleanest path is to add
a new tier (e.g., `ultra`) rather than to narrow `aggressive`. That's
a separate decision.

---

## Configuration Changes

### Config Type (`packages/core/src/types/config.ts`)

```typescript
export interface FeaturesConfig {
  // ... existing fields ...
  
  /**
   * Token-saving mode level. Controls how aggressively the system prompt
   * is compacted to reduce per-request token consumption.
   *
   * - 'off'        — Full prompt, all tools, complete guidance
   * - 'minimal'    — TIER1 tools only, stripped guidance (~3-4k tokens saved)
   * - 'light'      — TIER1 tools only, common patterns, minimal guidance
   *                   (same tool set as `minimal`; guidance differs)
   * - 'medium'     — TIER1 + TIER2 tools, some guidance
   * - 'aggressive' — TIER1 + TIER2 (minus `task`) + TIER3 (minus `setWorkingDir`),
   *                   maximum savings before tools become unusable (~4-5k tokens)
   *
   * Default: 'off'
   */
  tokenSavingMode?: TokenSavingTier | boolean | undefined;
  
  // DEPRECATED: boolean values for tokenSavingMode — use tier string instead
  // true  → 'medium'
  // false → 'off'
}
```

### Backward Compatibility

Boolean values for `tokenSavingMode` are deprecated but still supported:

```typescript
function normalizeTokenSavingTier(val?: boolean | TokenSavingTier): TokenSavingTier {
  if (val === undefined) return 'off';
  if (typeof val === 'boolean') return val ? 'medium' : 'off';
  return val;
}
```

---

## Tool Tier Definitions

### TIER1 — Core Essentials (~10 tools, ~600 tokens)

Must-have tools for any meaningful work:

```
read, write, edit, bash, grep, glob, diff, patch, json, search
```

**Memory tools** (always included in minimal+ tiers):
```
remember, forget, searchMemory, relatedMemory
```

### TIER2 — Standard Development (~15 tools, ~900 tokens)

Useful for development but not every turn:

```
replace, exec, fetch, git, tree,
lint, format, typecheck, test,
install, audit, design,
todo, plan, task
```

> Note: `design` was added to TIER2 in commit `4054e063` (the original design doc
> counted 14; current code has 15). It is registered at `medium` and `aggressive`
> tiers only.

### TIER3 — Specialized/Optional (~12 tools, ~800 tokens)

Can be disabled without impacting typical development:

```
outdated, logs, document, scaffold,
toolSearch, toolUse, batchToolUse, toolHelp,
codebaseIndex, codebaseSearch, codebaseStats,
setWorkingDir
```

### Tool Set by Tier

The actual implementation (`packages/cli/src/wiring/tools.ts:68-92`) is:

```typescript
export function getToolsForTier(tier: TokenSavingTier, allTools: Tool[]): Tool[] {
  const t1Names = new Set(TIER1_TOOLS.map((t) => t.name));
  const t2Names = new Set(TIER2_TOOLS.map((t) => t.name));
  const t3Names = new Set(TIER3_TOOLS.map((t) => t.name));

  switch (tier) {
    case 'off':
      return allTools;
    case 'minimal':
    case 'light':
      return allTools.filter((t) => t1Names.has(t.name));
    case 'medium':
      return allTools.filter((t) => t1Names.has(t.name) || t2Names.has(t.name));
    case 'aggressive':
      return allTools.filter(
        (t) =>
          t1Names.has(t.name) ||
          (t2Names.has(t.name) && t.name !== 'task') ||
          (t3Names.has(t.name) && t.name !== 'setWorkingDir'),
      );
  }
}
```

**Per-tier tool counts** (against `builtinTools` in `packages/tools/src/builtin.ts`):

| Tier | Filter | Count |
|---|---|---|
| `off` | allTools | 37 |
| `minimal` | TIER1 only | 10 |
| `light` | TIER1 only (same as `minimal`; guidance differs) | 10 |
| `medium` | TIER1 ∪ TIER2 | 25 |
| `aggressive` | TIER1 ∪ TIER2 (minus `task`) ∪ TIER3 (minus `setWorkingDir`) | 35 |

**Memory tools** (`remember`/`forget`/`searchMemory`/`relatedMemory`) are registered
separately in `setupTools()` based on `config.features.memory`, NOT filtered by
this function. They appear at every tier when `features.memory: true`.

---

## Guidance Sections by Tier

### Common Tool Patterns

| Tier | Behavior |
|------|----------|
| off | ✅ Full patterns block (~200 tokens) |
| minimal | ❌ Skipped |
| light | ✅ Full patterns block |
| medium | ✅ Full patterns block |
| aggressive | ✅ Full patterns block |

### Delegation Guidance

| Tier | Behavior |
|------|----------|
| off | Full delegation block (~600 tokens) |
| minimal | ❌ Skipped |
| light | Minimal one-liner: "Use `delegate` to hand work to subagents." |
| medium | Full delegation block |
| aggressive | Full delegation block |

### Mailbox Guidance

| Tier | Behavior |
|------|----------|
| off | Full mailbox block (~400 tokens) |
| minimal | ❌ Skipped |
| light | Minimal: "Use `mail_inbox` for messages, `mail_send` to communicate." |
| medium | Minimal one-liner with agent count |
| aggressive | Full mailbox block |

### Context Management Guidance

| Tier | Behavior |
|------|----------|
| off | Full context management block (~300 tokens) |
| minimal | ❌ Skipped (model knows this already) |
| light | ❌ Skipped |
| medium | Minimal one-liner: "Use `context_manager` to manage context." |
| aggressive | Full context management block |

### MCP Lazy-Loading Guidance

| Tier | Behavior |
|------|----------|
| off | Full MCP guidance with mcp_use and manual approach |
| minimal | Minimal: "Use `mcp_use({ server, tool, input })` for MCP tools." |
| light | Same as minimal |
| medium | Full MCP guidance |
| aggressive | Full MCP guidance |

---

## Environment Block by Tier

### Full (off)
```
## Environment

- Operating system: linux 5.15.0
- Shell: /bin/bash
- Node.js: v22.0.0
- Detected languages: JavaScript/TypeScript
- Git status: branch=main, 3 modified, 0 staged
- Today's date: 2026-06-19
- Running on: configured-provider/configured-model
- Context window: 200,000 tokens max
- Mode: default
```

### Minimal (minimal)
```
## Environment

- OS: linux | Shell: bash | Node: v22.0.0
- Git: branch=main, 3 modified
- Date: 2026-06-19
- Context: 200k tokens max
```

### Light (light)
```
## Environment

- Operating system: linux 5.15.0
- Shell: /bin/bash
- Detected languages: JavaScript/TypeScript
- Git status: branch=main, 3 modified
- Today's date: 2026-06-19
- Context window: 200,000 tokens max
```

### Medium (medium)
```
## Environment

- Operating system: linux 5.15.0
- Shell: /bin/bash
- Node.js: v22.0.0
- Detected languages: JavaScript/TypeScript
- Git status: branch=main, 3 modified
- Today's date: 2026-06-19
- Context window: 200,000 tokens max
```

### Aggressive (aggressive)
Same as medium but without `Detected languages`.

---

## Online Agents by Tier

| Tier | Behavior |
|------|----------|
| off | Full list with names, sessions, sources (~100 tokens for 5 agents) |
| minimal | " (5 agents online)" — just count, no list |
| light | " (5 agents online)" — just count |
| medium | Full list |
| aggressive | Full list |

---

## Memory Injection by Tier

| Tier | Max Items | Content |
|------|-----------|---------|
| off | 8 | Full entries with type badges, priority marks, tags |
| minimal | 3 | Compact entries: text only |
| light | 5 | Full entries with type badges |
| medium | 8 | Full entries |
| aggressive | 8 | Full entries |

---

## Skill Bodies by Tier

| Tier | Behavior |
|------|----------|
| off | Full `SKILL.md` body content (~400-800 chars/skill) |
| minimal | `SKILL.save.md` or auto-compacted to Overview+Rules (~200 chars/skill) |
| light | `SKILL.save.md` or auto-compacted |
| medium | `SKILL.save.md` or auto-compacted |
| aggressive | `SKILL.save.md` or auto-compacted |

---

## Tool Description Length by Tier

| Tier | Max Description Length |
|------|----------------------|
| off | 80 chars |
| minimal | 40 chars (first sentence only) |
| light | 50 chars |
| medium | 60 chars |
| aggressive | 70 chars |

```typescript
function getDescLength(tier: TokenSavingTier): number {
  switch (tier) {
    case 'off': return 80;
    case 'minimal': return 40;
    case 'light': return 50;
    case 'medium': return 60;
    case 'aggressive': return 70;
  }
}
```

---

## Implementation Plan

### Phase 1: Type System (`packages/core/src/types/config.ts`)

1. Add `TokenSavingTier` type
2. Update `FeaturesConfig.tokenSavingMode` to accept `TokenSavingTier | boolean`
3. Add migration helper `normalizeTokenSavingTier()`

### Phase 2: Tool Filtering (`packages/cli/src/wiring/tools.ts`)

1. Refactor `getToolsForTier()` function
2. Update `toolsToRegister` logic to use tier
3. Keep `TIER1_TOOLS` and `OPTIONAL_TOOLS` exports for backward compat

### Phase 3: System Prompt Builder (`packages/core/src/core/system-prompt-builder.ts`)

1. Change `tokenSavingMode?: boolean` to `tokenSavingTier?: TokenSavingTier`
2. Add helper methods for each guidance section:
   - `shouldIncludeCommonPatterns()`
   - `shouldIncludeFullDelegation()`
   - `shouldIncludeFullMailbox()`
   - `shouldIncludeContextManagement()`
3. Add `getToolDescLength()` helper
4. Add `getEnvironmentFormat()` helper
5. Update `buildMemoryAndSkills()` to use tier

### Phase 4: Skill Loader Enhancement (`packages/core/src/types/skill.ts`)

1. Add `readCompactBody(name, maxChars)` method to `SkillLoader`
2. Implement auto-compaction that extracts Overview + Rules + one Pattern section
3. Update `readSaveBody()` to respect tier length limits

### Phase 5: Deprecations and CLI (`packages/cli/src/cli-main.ts`)

1. Add `--token-saving-tier <level>` CLI flag
2. Update `--token-saving-mode` to map to `medium` tier
3. Add config file support for `tokenSavingMode: "minimal"`
4. Print tier level on startup

### Phase 6: Documentation

1. Update `docs/slash/tools.md` with tier documentation
2. Update `docs/configuration.md` with tier descriptions
3. Update `README.md` CLI flags section

---

## Files to Modify

| File | Changes |
|------|---------|
| `packages/core/src/types/config.ts` | Add `TokenSavingTier` type, update `FeaturesConfig` |
| `packages/cli/src/wiring/tools.ts` | Refactor tool filtering with `getToolsForTier()` |
| `packages/core/src/core/system-prompt-builder.ts` | Update all tier-aware logic |
| `packages/core/src/types/skill.ts` | Add compact body read method |
| `packages/core/src/execution/skill-loader.ts` | Implement skill auto-compaction |
| `packages/cli/src/cli-main.ts` | Add `--token-saving-tier` flag |
| `packages/tools/src/builtin.ts` | Update `TIER1_TOOLS`, `OPTIONAL_TOOLS` docs |

---

## Example Configurations

### Quick Fix (minimal)
```json
{
  "features": {
    "tokenSavingMode": "minimal"
  }
}
```

### Standard Development (light)
```json
{
  "features": {
    "tokenSavingMode": "light"
  }
}
```

### Multi-Agent Complex Task (off)
```json
{
  "features": {
    "tokenSavingMode": "off"
  }
}
```

---

## Backward Compatibility Notes

1. `tokenSavingMode: true` → `tokenSavingMode: "medium"`
2. `tokenSavingMode: false` → `tokenSavingMode: "off"`
3. `TIER1_TOOLS` export still valid — maps to `minimal`/`light` tier
4. `OPTIONAL_TOOLS` export still valid — tools not in current tier
5. CLI `--token-saving-mode` flag still works — maps to `"medium"`
6. New `--token-saving-tier <level>` flag supersedes `--token-saving-mode`
