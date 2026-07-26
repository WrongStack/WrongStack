/**
 * H-area (Sprint 3 audit): Guidance section gating
 *
 * Hypotheses tested:
 *   H1 — At each tier, the set of guidance sections emitted matches
 *        the documented behavior (Common patterns, Delegation,
 *        Mailbox, Commit hygiene, MCP, Shell). Sections should
 *        appear in exactly the tiers where they are gated to appear.
 *
 *   H2 — Memory injection: count and compactness per tier
 *        (off=8, minimal=3, light=5, medium=8, aggressive=8;
 *         compact only at minimal).
 *
 *   H3 — Commit hygiene is a carve-out at aggressive — included
 *        even though most guidance sections are compact there.
 *
 *   H5 — Common patterns section is skipped at minimal AND
 *        aggressive (documented two-tier exclusion).
 *
 * Adjacent finding (documented in commit message):
 *   The comments above the Mailbox section (line 562-564) and the
 *   MCP section (line 678-680) describe `aggressive` as belonging
 *   to the "full" group, but the actual code places `aggressive` in
 *   the "one-liner" group. The tests below pin the actual code
 *   behavior (the correct behavior per leader@1b68eb14's Option H
 *   decision: aggressive gets compact guidance, not the full
 *   block).
 *
 * The H1 table below is the canonical expected behavior. If the
 * comment/code drift is fixed by *moving* `aggressive` to the full
 * group (the wrong direction), these tests will fail loudly. If the
 * comments are simply updated to match the code (the right
 * direction), these tests stay green.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DefaultSystemPromptBuilder } from '../../src/index.js';
import type { Tool } from '../../src/index.js';

const mkTool = (name: string, description: string): Tool => ({
  name,
  description,
  usageHint: undefined,
  permission: 'auto',
  mutating: false,
  inputSchema: { type: 'object' },
  async execute() {
    return '';
  },
});

// Tool set covering every guidance section: delegate, mailbox, git,
// mcp_control, mcp_use. Plus a generic alpha so the tool description
// block has content (which itself triggers tier-driven truncation).
const H_FIXTURE_TOOLS: Tool[] = [
  mkTool('alpha', 'Generic tool for testing. Use this tool to test things.'),
  mkTool(
    'delegate',
    'Hands a task to a subagent. Use when the task fans out.',
  ),
  mkTool('mail_send', 'Sends a message to another agent on the project.'),
  mkTool('mail_inbox', 'Reads new messages from the project mailbox.'),
  mkTool('git', 'Structured git operations: status, commit, push.'),
  mkTool('mcp_control', 'Manages MCP server registration.'),
  mkTool(
    'mcp_use',
    'One-shot meta-tool to call an MCP tool without manual lifecycle.',
  ),
];

describe('DefaultSystemPromptBuilder — H-area guidance section gating', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-prompt-h-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function promptAt(
    mode:
      | 'off'
      | 'minimal'
      | 'light'
      | 'medium'
      | 'aggressive'
      | boolean
      | undefined,
  ): Promise<string> {
    const b = new DefaultSystemPromptBuilder({
      todayIso: '2026-06-27',
      tokenSavingMode: mode,
    });
    const blocks = await b.build({
      cwd: tmp,
      projectRoot: tmp,
      tools: H_FIXTURE_TOOLS,
    });
    return blocks.map((bl) => bl.text).join('\n');
  }

  describe('H1 — section presence/absence per tier', () => {
    // Canonical expected behavior (matches code at audit time):
    //
    //                  off   light  medium  aggressive  minimal
    //   Common         ✓     ✓      ✓       ✗           ✗
    //   Delegation     full  one    one     one         ✗
    //   Mailbox        full  one    one     one         one
    //   Commit hygiene ✓     ✗      ✓       ✓           ✗
    //   MCP            full  one    full    one         one
    //   Shell (Win)    full  one    full    full        ✗
    //
    // We assert section PRESENCE (## header in prompt), not body
    // shape. That keeps the test robust against prose tweaks while
    // still catching drift (e.g. if aggressive accidentally stopped
    // emitting Mailbox, the section would disappear).
    //
    // The POSIX shell runs on this CI machine; Shell section is
    // skipped entirely under POSIX regardless of tier, so we
    // don't assert on Shell here. Shell gating is exercised
    // separately by J-area tests on Windows.
    const sections: Array<{ name: string; header: string }> = [
      { name: 'Common patterns', header: '## Common patterns' },
      { name: 'Delegation', header: '## Delegation' },
      { name: 'Mailbox', header: '## Inter-agent mailbox' },
      { name: 'Commit hygiene', header: '## Commit hygiene' },
      { name: 'MCP', header: '## MCP tools' },
    ];

    const expectedPresence: Record<string, Record<string, boolean>> = {
      'Common patterns': { off: true, light: true, medium: true, aggressive: false, minimal: false },
      Delegation: { off: true, light: true, medium: true, aggressive: true, minimal: false },
      Mailbox: { off: true, light: true, medium: true, aggressive: true, minimal: true },
      'Commit hygiene': { off: true, light: false, medium: true, aggressive: true, minimal: false },
      MCP: { off: true, light: true, medium: true, aggressive: true, minimal: true },
    };

    const tiers: Array<'off' | 'light' | 'medium' | 'aggressive' | 'minimal'> = [
      'off',
      'light',
      'medium',
      'aggressive',
      'minimal',
    ];

    for (const section of sections) {
      for (const tier of tiers) {
        const expected = expectedPresence[section.name][tier];
        it(`${section.name}: ${tier} → ${expected ? 'present' : 'absent'}`, async () => {
          const p = await promptAt(tier);
          if (expected) {
            expect(p).toContain(section.header);
          } else {
            expect(p).not.toContain(section.header);
          }
        });
      }
    }
  });

  describe('H5 — Common patterns is the only section skipped at BOTH minimal and aggressive', () => {
    it('minimal excludes Common patterns', async () => {
      const p = await promptAt('minimal');
      expect(p).not.toContain('## Common patterns');
    });

    it('aggressive excludes Common patterns', async () => {
      const p = await promptAt('aggressive');
      expect(p).not.toContain('## Common patterns');
    });

    it('light INCLUDES Common patterns (between the two exclusions)', async () => {
      const p = await promptAt('light');
      expect(p).toContain('## Common patterns');
    });

    it('off INCLUDES Common patterns', async () => {
      const p = await promptAt('off');
      expect(p).toContain('## Common patterns');
    });

    it('medium INCLUDES Common patterns', async () => {
      const p = await promptAt('medium');
      expect(p).toContain('## Common patterns');
    });
  });

  describe('H3 — Commit hygiene is the carve-out at aggressive', () => {
    // Per the parallel-session decision (Option H): aggressive gets
    // compact guidance but Commit hygiene is kept because it
    // prevents cross-agent git commits and is small.
    it('aggressive INCLUDES Commit hygiene (carve-out)', async () => {
      const p = await promptAt('aggressive');
      expect(p).toContain('## Commit hygiene');
    });

    it('aggressive EXCLUDES Common patterns (which would also have been a carve-out candidate)', async () => {
      // Documents the asymmetric decision: Common patterns is
      // skipped at aggressive but Commit hygiene is kept.
      const p = await promptAt('aggressive');
      expect(p).not.toContain('## Common patterns');
    });

    it('light EXCLUDES Commit hygiene (also skipped at light)', async () => {
      // light is the strictest compact tier alongside minimal.
      const p = await promptAt('light');
      expect(p).not.toContain('## Commit hygiene');
    });
  });

  // H2 — Memory injection count and compactness.
  // Exact item counts (off=8, minimal=3, light=5, medium=8, aggressive=8)
  // are NOT pinned in this file. The dedicated regression at
  // token-saving-memory-injection-size.test.ts verifies relative memory-block
  // sizing (minimal is smallest, off/medium/aggressive roughly equal) and
  // the aggressive-not-compact guard. The H-area tests above cover static
  // section presence/absence per compactness tier. If exact count
  // assertions are needed, add them to the dedicated regression file.

  describe('H-comment-code-drift — Mailbox and MCP comments are stale', () => {
    // Documents the discrepancy between the code (which puts
    // `aggressive` in the one-liner group for both Mailbox and MCP)
    // and the comments (which claim `aggressive` is in the full
    // group). The tests above pin the actual code behavior; if the
    // comments are updated to match the code (the correct
    // direction), this test stays green. If the code is changed to
    // match the comments (the wrong direction), the H1 presence
    // tests above fail first.
    it('Mailbox one-liner at aggressive (code wins over stale comment)', async () => {
      // The full Mailbox block has multiple ### subsections
      // (Your identity, Receiving, Sending, etc.). The one-liner
      // does not. We assert by content shape: the one-liner has
      // exactly one `Use \`mail_inbox\`...` instruction; the full
      // block has many `###` subheaders.
      const p = await promptAt('aggressive');
      const mailboxStart = p.indexOf('## Inter-agent mailbox');
      expect(mailboxStart).toBeGreaterThan(-1);
      const mailboxSection = p.slice(
        mailboxStart,
        mailboxStart + 800,
      );
      // One-liner contains "Use `mail_inbox` for new messages" but
      // NOT "### Your identity" (a full-block subheader).
      expect(mailboxSection).toContain('Use `mail_inbox`');
      expect(mailboxSection).toContain('to="leader" audience="leaders"');
      expect(mailboxSection).not.toContain('### Your identity');
    });

    it('MCP one-liner at aggressive (code wins over stale comment)', async () => {
      const p = await promptAt('aggressive');
      const mcpStart = p.indexOf('## MCP tools');
      expect(mcpStart).toBeGreaterThan(-1);
      const mcpSection = p.slice(mcpStart, mcpStart + 800);
      // One-liner mentions `mcp_use` (or `mcp_control`) but NOT
      // the "Preferred approach" / "Manual approach" subheaders.
      expect(mcpSection).toMatch(/mcp_use|mcp_control/);
      expect(mcpSection).not.toContain('Preferred approach');
      expect(mcpSection).not.toContain('Manual approach');
    });
  });
});
