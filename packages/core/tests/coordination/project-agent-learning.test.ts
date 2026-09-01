import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildConsolidationInstruction,
  buildProjectContextualizedPrompt,
  captureLearnedFromAgentOutputDetailed,
  classifyLearnedEntry,
  clearProjectAgentConsolidated,
  createProjectAgent,
  createProjectAgentRoster,
  decomposeLearnedEntry,
  getProjectAgentLearnStats,
  isConsolidated,
  LEARNED_ENTRY_MAX_CHARS,
  listProjectAgentLearnedEntries,
  listProjectAgentRoles,
  loadConsolidationMetadata,
  loadProjectAgentConsolidated,
  mergeStructuredEntries,
  normalizeLearnedEntry,
  parseLearnedEntryStamp,
  parseStructuredLearnedEntries,
  renderLearnedInstructions,
  saveProjectAgentConsolidated,
  updateProjectAgentConfig,
  updateProjectAgentLearned,
  updateProjectAgentLearningPolicy,
  validateProjectAgentConfig,
} from '../../src/coordination/agents/project-agent-identity.js';

describe('project agent self-learning lifecycle', () => {
  let projectRoot = '';

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wrongstack-agent-learning-'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('captures durable blocks, persists counters, and deduplicates within one result', () => {
    const learning =
      'Use the repository package manager and run the narrow package test before the workspace suite so failures remain attributable.';
    const result = captureLearnedFromAgentOutputDetailed(
      `Done.\n\n## LEARNED\n${learning}\n\n## LEARNED\n${learning}`,
      'executor',
      projectRoot,
    );

    expect(result).toMatchObject({ status: 'captured', captured: 1, skipped: 1 });
    // After the refactor the buffer is the structured instruction list, so
    // the entry count is observed via parseStructuredLearnedEntries rather
    // than the raw chunked buffer.
    expect(parseStructuredLearnedEntries('executor', projectRoot)).toHaveLength(1);
    expect(getProjectAgentLearnStats('executor', projectRoot)).toMatchObject({
      entryCount: 1,
      lifetimeCaptureCount: 1,
      lastCaptureSource: 'automatic',
    });
  });

  it('splits blocks when a later heading omits the space after ##', () => {
    // The block-start regex accepts `##LEARNED` ([ \t]* lets the space be
    // zero), so the delimiter must recognise that same form as a boundary.
    // `/^##\s/` alone absorbed the second block into the first: two distinct
    // directives collapsed into one candidate whose text contained the
    // literal `##LEARNED` marker.
    const lessonA = 'Always run pnpm typecheck before declaring work complete.';
    const lessonB = 'Avoid mutating shared state in async handlers.';
    const result = captureLearnedFromAgentOutputDetailed(
      `## LEARNED\n${lessonA}\n\n##LEARNED\n${lessonB}`,
      'executor',
      projectRoot,
      true,
    );
    expect(result).toMatchObject({ status: 'captured', captured: 2, skipped: 0 });
    const entries = parseStructuredLearnedEntries('executor', projectRoot);
    expect(entries).toHaveLength(2);
    const texts = entries.map((entry) => entry.what);
    expect(texts).toContain(lessonA);
    expect(texts).toContain(lessonB);
    for (const text of texts) expect(text).not.toContain('##LEARNED');
  });

  it('does not consume the automatic capture guard when output has no LEARNED block', () => {
    expect(
      captureLearnedFromAgentOutputDetailed('ordinary task output', 'reviewer', projectRoot),
    ).toMatchObject({ status: 'no_blocks', captured: 0 });

    const result = captureLearnedFromAgentOutputDetailed(
      '## LEARNED\nReview migrations together with their rollback path because schema-only checks miss operational recovery failures.',
      'reviewer',
      projectRoot,
    );
    expect(result.status).toBe('captured');
  });

  it('pauses automatic capture and prompt injection without deleting learned data', () => {
    updateProjectAgentLearned(
      'architect',
      'The project keeps transport contracts in the protocol package and UI mirrors must remain structurally compatible.',
      projectRoot,
      'replace',
    );
    updateProjectAgentLearningPolicy('architect', { enabled: false }, projectRoot);

    const result = captureLearnedFromAgentOutputDetailed(
      '## LEARNED\nKeep architectural boundaries explicit and verify package exports whenever a new cross-package import is introduced.',
      'architect',
      projectRoot,
    );
    expect(result.status).toBe('disabled');
    // The buffer is the structured instruction list now, so entry count is
    // observed via the structured parser.
    expect(parseStructuredLearnedEntries('architect', projectRoot)).toHaveLength(1);
    expect(buildProjectContextualizedPrompt('base prompt', 'architect', projectRoot)).not.toContain(
      'transport contracts',
    );
  });

  it('rejects traversal-shaped role ids before touching the filesystem', () => {
    expect(() =>
      updateProjectAgentLearned('../outside', 'should never be written', projectRoot, 'replace'),
    ).toThrow(/Invalid project agent role/);
    expect(fs.existsSync(path.join(projectRoot, '.wrongstack', 'outside'))).toBe(false);
  });

  it('enforces the per-session cap within a multi-block response', () => {
    const output = [
      'Run focused contract tests before broad suites so failures remain attributable to the changed package.',
      'Preserve user-owned dirty files and inspect overlapping diffs before applying any repository edit.',
      'Validate all filesystem role identifiers before joining them into project customization paths.',
      'Reload durable learned context for every spawn so cached prompts cannot retain stale project guidance.',
      'Record learning counters only after an entry is actually accepted and written successfully to disk.',
    ]
      .map((lesson) => `## LEARNED\n${lesson}`)
      .join('\n\n');

    const result = captureLearnedFromAgentOutputDetailed(output, 'tester', projectRoot);
    expect(result).toMatchObject({ status: 'captured', captured: 3, skipped: 2 });
    expect(parseStructuredLearnedEntries('tester', projectRoot)).toHaveLength(3);
  });

  it('discovers config-only project agent roles', () => {
    updateProjectAgentConfig('custom-reviewer', { tools: ['read_file'] }, projectRoot);
    expect(listProjectAgentRoles(projectRoot)).toContain('custom-reviewer');
  });

  it('creates a generic-derived role with isolated identity and learning', () => {
    const profile = createProjectAgent(
      {
        name: 'ABC',
        purpose: 'Own X, Y and Z workflows for this project.',
        taskTypes: ['X workflow', 'Y analysis', 'Z verification'],
      },
      projectRoot,
    );
    const roster = createProjectAgentRoster(
      {
        generic: { id: 'generic', role: 'generic', name: 'Generic', prompt: 'GENERIC-BASE' },
      },
      projectRoot,
    );

    expect(profile.role).toBe('abc');
    expect(Object.keys(roster)).toContain('abc');
    expect(roster['abc']).toMatchObject({
      id: 'abc',
      role: 'abc',
      name: 'ABC',
      prompt: 'GENERIC-BASE',
    });

    const lesson =
      'When processing Z verification, compare the generated artifact with the project contract before reporting completion.';
    expect(
      captureLearnedFromAgentOutputDetailed(`## LEARNED\n${lesson}`, 'abc', projectRoot, true),
    ).toMatchObject({ status: 'captured', captured: 1 });
    const prompt = buildProjectContextualizedPrompt('GENERIC-BASE', 'abc', projectRoot);
    expect(prompt).toContain('Own X, Y and Z workflows');
    expect(prompt).toContain(lesson);
    expect(listProjectAgentLearnedEntries('generic', projectRoot)).toHaveLength(0);
  });

  it('clones built-in and custom roster roles while keeping independent identity', () => {
    const first = createProjectAgent(
      {
        name: 'Project Hunter',
        baseRole: 'bug-hunter',
        purpose: 'Find project-specific runtime and integration defects.',
        taskTypes: ['bug investigation', 'regression verification'],
      },
      projectRoot,
    );
    updateProjectAgentConfig('project-hunter', { tools: ['read_file'] }, projectRoot);
    const second = createProjectAgent(
      {
        name: 'Focused Hunter',
        baseRole: 'project-hunter',
        purpose: 'Investigate defects in a narrowly assigned package.',
        taskTypes: ['focused defect investigation'],
      },
      projectRoot,
    );
    const roster = createProjectAgentRoster(
      {
        generic: { name: 'Generic', role: 'generic', prompt: 'GENERIC' },
        'bug-hunter': {
          name: 'Bug Hunter',
          role: 'bug-hunter',
          prompt: 'BUG-HUNTER-PERSONA',
          tools: ['read_file', 'bash'],
          skillNames: ['debugging'],
        },
      },
      projectRoot,
    );

    expect(first.baseRole).toBe('bug-hunter');
    expect(second.baseRole).toBe('project-hunter');
    expect(roster['project-hunter']).toMatchObject({
      role: 'project-hunter',
      prompt: 'BUG-HUNTER-PERSONA',
      tools: ['read_file'],
      skillNames: ['debugging'],
    });
    expect(roster['focused-hunter']).toMatchObject({
      role: 'focused-hunter',
      prompt: 'BUG-HUNTER-PERSONA',
      tools: ['read_file'],
      skillNames: ['debugging'],
    });
    expect(listProjectAgentLearnedEntries('project-hunter', projectRoot)).toHaveLength(0);
    expect(listProjectAgentLearnedEntries('focused-hunter', projectRoot)).toHaveLength(0);
  });

  it('applies live runtime policy while preserving built-in system safety floors', () => {
    updateProjectAgentConfig(
      'executor',
      {
        tools: ['bash'],
        // Was 'shell.execute', which is not a capability this codebase defines
        // (the real name is 'shell.exec') and appeared nowhere outside this
        // test. It survived only because project-supplied capabilities used to
        // be stored verbatim; the WS-079 clamp now drops unknown strings.
        allowedCapabilities: ['shell.exec', 'config.mutate'],
        budget: { timeoutMs: 1, maxIterations: 1, maxToolCalls: 1, maxTokens: 1 },
        modelPolicy: {
          allowed: [{ provider: 'openai', model: 'gpt-system' }],
          strict: true,
        },
        availability: {
          timezone: 'UTC',
          days: [1],
          start: '09:00',
          end: '10:00',
          mode: 'enforce',
        },
      },
      projectRoot,
    );
    const roster = createProjectAgentRoster(
      {
        executor: {
          name: 'Executor',
          role: 'executor',
          tools: ['read_file'],
          allowedCapabilities: ['fs.read'],
        },
      },
      projectRoot,
    );

    expect(roster['executor']).toMatchObject({
      tools: ['read_file', 'bash'],
      // 'config.mutate' is requested above but is outside the wide-subagent
      // ceiling, so the clamp drops it: a repo-committed agent config may
      // narrow a grant, never widen one (WS-079).
      allowedCapabilities: ['fs.read', 'shell.exec'],
      timeoutMs: 300_000,
      maxIterations: 20,
      maxToolCalls: 40,
      maxTokens: 8_192,
      modelPolicy: { strict: false },
      availability: { mode: 'advisory' },
    });
  });

  it('allows generic-derived roles to use strict, narrow runtime policies', () => {
    createProjectAgent(
      { name: 'ABC', purpose: 'Own project release checks.', taskTypes: ['release checks'] },
      projectRoot,
    );
    updateProjectAgentConfig(
      'abc',
      {
        tools: ['read_file'],
        allowedCapabilities: ['fs.read'],
        budget: { maxIterations: 2 },
        cwd: 'packages/core',
        worktree: 'required',
        modelPolicy: {
          allowed: [{ provider: 'openai', model: 'gpt-custom' }],
          strict: true,
        },
        availability: {
          timezone: 'Europe/Kiev',
          days: [1, 2, 3, 4, 5],
          start: '09:00',
          end: '18:00',
          mode: 'enforce',
        },
      },
      projectRoot,
    );
    const roster = createProjectAgentRoster(
      { generic: { name: 'Generic', role: 'generic', tools: ['bash'] } },
      projectRoot,
    );

    expect(roster['abc']).toMatchObject({
      tools: ['read_file'],
      allowedCapabilities: ['fs.read'],
      maxIterations: 2,
      cwd: 'packages/core',
      worktree: 'required',
      modelPolicy: { strict: true },
      availability: { mode: 'enforce' },
    });
  });

  it('rejects escaping workdirs and fallback models outside the allowlist', () => {
    expect(() => validateProjectAgentConfig({ cwd: '../outside' })).toThrow(/assigned checkout/);
    expect(() =>
      validateProjectAgentConfig({
        modelPolicy: {
          allowed: [{ provider: 'openai', model: 'primary' }],
          fallbacks: [{ provider: 'other', model: 'unapproved' }],
        },
      }),
    ).toThrow(/must also appear in allowed/);
  });

  it('normalizes cwd before returning validated config', () => {
    // Windows-style path with leading/trailing whitespace.
    const config = validateProjectAgentConfig({ cwd: '  packages\\core  ' });
    expect(config.cwd).toBe('packages/core');
  });

  // ── Consolidation lifecycle ──────────────────────────────────────────

  it('saves, loads, and clears consolidated documents with metadata', () => {
    expect(isConsolidated('executor', projectRoot)).toBe(false);
    expect(loadProjectAgentConsolidated('executor', projectRoot)).toBe('');
    expect(loadConsolidationMetadata('executor', projectRoot)).toBeUndefined();

    // Seed some raw entries so metadata can record them
    updateProjectAgentLearned(
      'executor',
      'Always run pnpm typecheck before declaring work complete.',
      projectRoot,
      'replace',
    );

    const content =
      '# Consolidated knowledge for executor\n\n- Run pnpm typecheck before completion.';
    saveProjectAgentConsolidated('executor', content, projectRoot);

    expect(isConsolidated('executor', projectRoot)).toBe(true);
    expect(loadProjectAgentConsolidated('executor', projectRoot)).toBe(content);

    const meta = loadConsolidationMetadata('executor', projectRoot);
    expect(meta).toBeDefined();
    expect(meta!.sourceEntryCount).toBe(1);
    expect(meta!.consolidatedBytes).toBeGreaterThan(0);
    expect(meta!.trigger).toBe('manual');

    clearProjectAgentConsolidated('executor', projectRoot);
    expect(isConsolidated('executor', projectRoot)).toBe(false);
    expect(loadConsolidationMetadata('executor', projectRoot)).toBeUndefined();
  });

  it('prefers consolidated content over raw learned.md in the contextualized prompt', () => {
    const rawEntry =
      'Raw verbose entry about checking migrations together with their recovery strategy before merging.';
    updateProjectAgentLearned('reviewer', rawEntry, projectRoot, 'replace');
    const consolidated = '## Migrations\n\n- Verify rollback paths for all schema changes.';
    saveProjectAgentConsolidated('reviewer', consolidated, projectRoot);

    const prompt = buildProjectContextualizedPrompt('BASE', 'reviewer', projectRoot);
    expect(prompt).toContain(consolidated);
    expect(prompt).toContain('Consolidated knowledge');
    // The raw verbose entry should NOT be in the prompt (only the consolidated version)
    expect(prompt).not.toContain('recovery strategy');
  });

  it('appends stale raw entries after consolidated content when new captures arrive', () => {
    // Seed and consolidate one entry
    updateProjectAgentLearned(
      'tester',
      'Run focused tests before broad suites.',
      projectRoot,
      'replace',
    );
    saveProjectAgentConsolidated(
      'tester',
      '# Consolidated\n\n- Run focused tests first.',
      projectRoot,
    );

    const meta = loadConsolidationMetadata('tester', projectRoot);
    expect(meta!.sourceEntryCount).toBe(1);

    // Capture a new raw entry after consolidation
    updateProjectAgentLearned(
      'tester',
      'Always inspect the git diff before applying edits.',
      projectRoot,
      'append',
    );

    const prompt = buildProjectContextualizedPrompt('BASE', 'tester', projectRoot);
    // Consolidated content is present
    expect(prompt).toContain('Run focused tests first');
    // The new stale entry is appended under the "Recently captured" heading
    expect(prompt).toContain('inspect the git diff');
    expect(prompt).toContain('pending next optimization');
  });

  it('falls back to raw learned.md when no consolidation exists', () => {
    updateProjectAgentLearned(
      'architect',
      'Keep transport contracts in the protocol package.',
      projectRoot,
      'replace',
    );
    const prompt = buildProjectContextualizedPrompt('BASE', 'architect', projectRoot);
    expect(prompt).toContain('transport contracts');
    expect(prompt).toContain('Learned instructions for this project');
  });

  it('builds a consolidation instruction containing all raw entries', () => {
    updateProjectAgentLearned(
      'bug-hunter',
      'Check for null guards before property access.',
      projectRoot,
      'replace',
    );
    updateProjectAgentLearned(
      'bug-hunter',
      'Verify async error handling in all catch blocks.',
      projectRoot,
      'append',
    );

    const { instruction, rawEntries, hasExistingConsolidation } = buildConsolidationInstruction(
      'bug-hunter',
      projectRoot,
    );

    expect(rawEntries).toHaveLength(2);
    expect(hasExistingConsolidation).toBe(false);
    expect(instruction).toContain('null guards');
    expect(instruction).toContain('async error handling');
    expect(instruction).toContain('Be selective');
  });

  it('tracks consolidation state in getProjectAgentLearnStats', () => {
    updateProjectAgentLearned(
      'executor',
      'Some learned content for testing.',
      projectRoot,
      'replace',
    );
    const statsBefore = getProjectAgentLearnStats('executor', projectRoot);
    expect(statsBefore.isConsolidated).toBe(false);
    expect(statsBefore.consolidation).toBeUndefined();

    saveProjectAgentConsolidated('executor', '# Consolidated content', projectRoot);

    const statsAfter = getProjectAgentLearnStats('executor', projectRoot);
    expect(statsAfter.isConsolidated).toBe(true);
    expect(statsAfter.consolidation).toBeDefined();
    expect(statsAfter.consolidation!.sourceEntryCount).toBe(1);
    expect(statsAfter.consolidation!.consolidatedAt).toBeTruthy();
  });

  it('lists roles that only have consolidated files', () => {
    // Clear any pre-existing executor data from other tests
    saveProjectAgentConsolidated('unique-role', '# Just consolidated', projectRoot);
    const roles = listProjectAgentRoles(projectRoot);
    expect(roles).toContain('unique-role');
  });

  it('rejects invalid consolidation metadata gracefully', () => {
    // Manually write invalid JSON to consolidation.json
    const dir = path.join(projectRoot, '.wrongstack', 'agents', 'executor');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'consolidation.json'), '{"broken": true}');

    expect(loadConsolidationMetadata('executor', projectRoot)).toBeUndefined();
  });

  // ── Instructive capture: normalization + classification ──────────────────
  //
  // The capture pipeline must reject narrative / ephemeral content and
  // produce directive entries. These tests pin the normalization behavior
  // so the buffer stays readable and teachable across sessions.

  describe('instructive capture (normalization)', () => {
    it('strips commit SHAs, timestamps, line numbers, and PR refs from a captured entry', () => {
      const result = normalizeLearnedEntry(
        'When reviewing commit 9c7682b84abc on 2026-07-22T10:30:00Z, the poll lock at line 42 of poll-lock.ts must use writeFileSync with the wx flag (PR #100).',
      );
      expect(result).not.toBeNull();
      // Ephemeral artifacts should be gone.
      expect(result!.text).not.toMatch(/9c7682b84/);
      expect(result!.text).not.toMatch(/2026-07-22/);
      expect(result!.text).not.toMatch(/line\s+\d+/i);
      expect(result!.text).not.toMatch(/#100/);
      // The directive substance survives.
      expect(result!.text).toMatch(/poll[- ]lock/i);
      expect(result!.text).toMatch(/wx/);
    });

    it('rejects entirely-narrative entries that cannot be salvaged', () => {
      // Pure session log — describes an event with no directive.
      expect(
        normalizeLearnedEntry('Today I noticed that the test suite took 4 minutes to run.'),
      ).toBeNull();
      expect(normalizeLearnedEntry('Yesterday I worked on the auth module.')).toBeNull();
      expect(normalizeLearnedEntry('I found that commit abc1234 had a bug.')).toBeNull();
    });

    it('salvages the directive tail from a narrative-framed entry', () => {
      const result = normalizeLearnedEntry(
        'When retrying a 429 from the Telegram API, prefer an exponential backoff with 30% jitter over a fixed delay.',
      );
      expect(result).not.toBeNull();
      // The narrative "When retrying" framing should be stripped but the
      // directive tail preserved.
      expect(result!.text.toLowerCase()).toContain('prefer');
      expect(result!.text.toLowerCase()).toMatch(/exponential.*backoff/);
      expect(result!.text.toLowerCase()).toMatch(/jitter/);
    });

    it('keeps clean directives intact without modification', () => {
      const directive =
        'Always run pnpm typecheck before declaring a refactor complete. Use the focused package typecheck, not the workspace-wide one.';
      const result = normalizeLearnedEntry(directive);
      expect(result).not.toBeNull();
      expect(result!.text).toBe(directive);
    });

    it('truncates over-long entries to the first instructive sentence cluster', () => {
      const long = Array.from(
        { length: 30 },
        (_, i) => `Always run a regression test on package ${i} before merging a change.`,
      ).join(' ');
      const result = normalizeLearnedEntry(long);
      expect(result).not.toBeNull();
      expect(result!.text.length).toBeLessThanOrEqual(LEARNED_ENTRY_MAX_CHARS);
      expect(result!.text.length).toBeGreaterThan(0);
    });

    it('rejects entries that are too short after normalization', () => {
      expect(normalizeLearnedEntry('Use X.')).toBeNull();
      expect(normalizeLearnedEntry('Always.')).toBeNull();
      expect(normalizeLearnedEntry('')).toBeNull();
    });

    it('classifies entries by content into the correct category', () => {
      expect(classifyLearnedEntry('Always verify typecheck before merge.')).toBe('convention');
      expect(classifyLearnedEntry('Use pnpm for monorepo package management.')).toBe('pattern');
      expect(classifyLearnedEntry('Avoid mutating shared state in async handlers.')).toBe(
        'warning',
      );
      expect(classifyLearnedEntry('The project uses vitest 2.x for unit tests.')).toBe('fact');
    });

    it('stamps captured entries with their category for scannability', () => {
      captureLearnedFromAgentOutputDetailed(
        '## LEARNED\nAlways run pnpm typecheck before declaring work complete.',
        'executor',
        projectRoot,
      );
      const entries = parseStructuredLearnedEntries('executor', projectRoot);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.category).toBe('convention');
    });

    it('does not persist purely-narrative LEARNED blocks (session-log rejection)', () => {
      const result = captureLearnedFromAgentOutputDetailed(
        '## LEARNED\nToday I noticed that the build took a long time and we changed the test runner last week.',
        'tester',
        projectRoot,
      );
      expect(result.status).toBe('quality_rejected');
      expect(listProjectAgentLearnedEntries('tester', projectRoot)).toHaveLength(0);
    });

    it('strips ephemeral anchors from a verbose narrative so the directive persists', () => {
      const result = captureLearnedFromAgentOutputDetailed(
        [
          '## LEARNED',
          'When I worked on commit 9c7682b84 on 2026-07-22, the poll-lock at line 42 had to use the wx flag in writeFileSync so concurrent writers would not both succeed.',
        ].join('\n'),
        'executor',
        projectRoot,
      );
      expect(result.status).toBe('captured');
      const entries = parseStructuredLearnedEntries('executor', projectRoot);
      expect(entries).toHaveLength(1);
      const directive = entries[0]!.what;
      // Ephemeral anchors gone, directive substance present.
      expect(directive).not.toMatch(/9c7682b84/);
      expect(directive).not.toMatch(/2026-07-22/);
      expect(directive).not.toMatch(/line\s+\d+/i);
      expect(directive.toLowerCase()).toMatch(/wx.*writefilesync|writefilesync.*wx/);
    });

    it('still rejects over-narrative multi-block responses even when one block is valid', () => {
      const output = [
        '## LEARNED',
        'Today I worked on the auth module and noticed some issues.',
        '',
        '## LEARNED',
        'Always validate JWT tokens against an explicit allowlist of algorithms before trusting any claim.',
      ].join('\n');
      const result = captureLearnedFromAgentOutputDetailed(output, 'reviewer', projectRoot);
      expect(result.status).toBe('captured');
      expect(result.captured).toBe(1);
      expect(result.skipped).toBe(1);
      const entries = parseStructuredLearnedEntries('reviewer', projectRoot);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.what).toMatch(/JWT/);
    });

    it('dedupes against normalized text so stripping ephemeral anchors does not bypass dedup', () => {
      // Two captures with the same lesson — the second must be rejected
      // as a near-duplicate. Use isManual=true to bypass cooldown.
      const first = captureLearnedFromAgentOutputDetailed(
        '## LEARNED\nAlways use the wx flag in writeFileSync when implementing concurrent locks.',
        'executor',
        projectRoot,
        true,
      );
      const second = captureLearnedFromAgentOutputDetailed(
        '## LEARNED\nAlways use the wx flag in writeFileSync when implementing concurrent locks.',
        'executor',
        projectRoot,
        true,
      );
      expect(first.status).toBe('captured');
      // Exact-duplicate entry must be rejected by the dedup gate.
      expect(second.status).toBe('quality_rejected');
      expect(parseStructuredLearnedEntries('executor', projectRoot)).toHaveLength(1);
    });
  });

  // ── Structured instruction list: merge + reformat on every capture ────────
  //
  // The capture pipeline must merge historical entries with the new entry and
  // rewrite the buffer as a structured instruction document with each entry
  // decomposed into what / why / how. The structured helpers are the public
  // surface — direct buffer reads are not stable across formats.

  describe('structured instruction list (capture-time consolidation)', () => {
    it('rewrites the buffer as a structured document with section headings per category', () => {
      captureLearnedFromAgentOutputDetailed(
        '## LEARNED\nAlways run pnpm typecheck before declaring work complete.',
        'executor',
        projectRoot,
      );
      captureLearnedFromAgentOutputDetailed(
        '## LEARNED\nAvoid mutating shared state in async handlers.',
        'executor',
        projectRoot,
        true,
      );
      captureLearnedFromAgentOutputDetailed(
        '## LEARNED\nUse pnpm for monorepo package management.',
        'executor',
        projectRoot,
        true,
      );
      const buffer = fs.readFileSync(
        path.join(projectRoot, '.wrongstack', 'agents', 'executor', 'learned.md'),
        'utf8',
      );
      // Structured headings — one per category present.
      expect(buffer).toMatch(/^# Learned instructions for `executor`/m);
      expect(buffer).toMatch(/^## What to avoid$/m);
      expect(buffer).toMatch(/^## What to do$/m);
      expect(buffer).toMatch(/^## Patterns to follow$/m);
      // The footer pinpoints the merge moment.
      expect(buffer).toMatch(/Last capture: .+ · 3 entries/);
    });

    it('decomposes each entry into what / why / how', () => {
      const { what, why, how } = decomposeLearnedEntry(
        'Always run `pnpm typecheck` before declaring work complete in `packages/core`.',
        'convention',
      );
      expect(what).toMatch(/pnpm typecheck/);
      // why must reflect the category (convention → guard against regressions)
      expect(why).toMatch(/regressions|convention/i);
      // how must surface the backticked command and the file path.
      expect(how).toMatch(/`pnpm typecheck`/);
      expect(how).toMatch(/`packages\/core`/);
    });

    it('renders structured entries grouped by category in the warning-first order', () => {
      const entries = [
        {
          key: 'k1',
          category: 'fact' as const,
          what: 'The project uses vitest 2.x.',
          why: 'project state',
          how: '',
          capturedAt: '2026-07-24T10:00:00Z',
        },
        {
          key: 'k2',
          category: 'warning' as const,
          what: 'Avoid mutating shared state.',
          why: 'race conditions',
          how: '',
          capturedAt: '2026-07-24T10:00:01Z',
        },
        {
          key: 'k3',
          category: 'convention' as const,
          what: 'Always run pnpm typecheck.',
          why: 'guard against regressions',
          how: '- `pnpm typecheck`',
          capturedAt: '2026-07-24T10:00:02Z',
        },
      ];
      const rendered = renderLearnedInstructions('tester', entries, '2026-07-24T10:00:02Z');
      const warningIdx = rendered.indexOf('## What to avoid');
      const conventionIdx = rendered.indexOf('## What to do');
      const factIdx = rendered.indexOf('## Project facts');
      expect(warningIdx).toBeGreaterThan(-1);
      expect(conventionIdx).toBeGreaterThan(warningIdx);
      expect(factIdx).toBeGreaterThan(conventionIdx);
      // Each entry rendered as a bold "what" + "why" + optional "how"
      expect(rendered).toMatch(/-\s+\*\*Always run pnpm typecheck\.\*\*/);
      expect(rendered).toMatch(/-\s+\*\*Avoid mutating shared state\.\*\*/);
      expect(rendered).toMatch(/-\s+\*\*The project uses vitest 2\.x\.\*\*/);
    });

    it('merges a new directive into existing entries, deduplicating by similarity', () => {
      const existing = parseStructuredLearnedEntries('nonexistent', projectRoot); // empty
      const merged = mergeStructuredEntries(existing, {
        text: 'Always run pnpm typecheck before declaring work complete.',
        category: 'convention',
        capturedAt: '2026-07-24T10:00:00Z',
      });
      expect(merged).toHaveLength(1);
      const again = mergeStructuredEntries(merged, {
        text: 'Always run pnpm typecheck before declaring work complete.', // exact dup
        category: 'convention',
        capturedAt: '2026-07-24T10:00:01Z',
      });
      expect(again).toHaveLength(1);
      const different = mergeStructuredEntries(again, {
        text: 'Avoid mutating shared state in async handlers.',
        category: 'warning',
        capturedAt: '2026-07-24T10:00:02Z',
      });
      expect(different).toHaveLength(2);
      // Sorted warning-first.
      expect(different[0]!.category).toBe('warning');
      expect(different[1]!.category).toBe('convention');
    });

    it('does not let a proven directive suppress the same wording in another category', () => {
      const existing = [
        {
          key: 'always run pnpm typecheck before declaring work complete',
          category: 'convention' as const,
          what: 'Always run pnpm typecheck before declaring work complete.',
          why: 'guard against regressions',
          how: '',
          capturedAt: '2026-07-24T10:00:00Z',
          applied: 5,
          wins: 5,
        },
      ];

      const merged = mergeStructuredEntries(existing, {
        text: 'Always run pnpm typecheck before declaring work complete.',
        category: 'warning',
        capturedAt: '2026-07-24T10:00:01Z',
      });

      expect(merged).toHaveLength(2);
      expect(merged.map((entry) => entry.category)).toEqual(['warning', 'convention']);
    });

    it('preserves historical entries through a re-capture (merge, not replace)', () => {
      captureLearnedFromAgentOutputDetailed(
        '## LEARNED\nAlways run pnpm typecheck before declaring work complete.',
        'executor',
        projectRoot,
      );
      const firstEntries = parseStructuredLearnedEntries('executor', projectRoot);
      expect(firstEntries).toHaveLength(1);

      captureLearnedFromAgentOutputDetailed(
        '## LEARNED\nAvoid mutating shared state in async handlers.',
        'executor',
        projectRoot,
        true,
      );
      const secondEntries = parseStructuredLearnedEntries('executor', projectRoot);
      expect(secondEntries).toHaveLength(2);
      // Both lessons survive the second capture.
      const whats = secondEntries.map((e) => e.what);
      expect(whats).toContain('Always run pnpm typecheck before declaring work complete.');
      expect(whats).toContain('Avoid mutating shared state in async handlers.');
    });

    it('parses stamps from existing entries so historical captures keep their metadata', () => {
      const stamped = `> [convention] Captured 2026-07-22T10:30:00Z

Always run pnpm typecheck before declaring work complete.`;
      const stamp = parseLearnedEntryStamp(stamped);
      expect(stamp.capturedAt).toBe('2026-07-22T10:30:00Z');
      expect(stamp.category).toBe('convention');
    });

    it('renders the empty-state scaffold for a refreshed role', () => {
      const empty = renderLearnedInstructions('fresh-role', [], '2026-07-24T10:00:00Z');
      expect(empty).toMatch(/^# Learned instructions for `fresh-role`/m);
      expect(empty).toMatch(/No learned entries yet/);
      expect(empty).toMatch(/0 entries/);
    });
  });
});
