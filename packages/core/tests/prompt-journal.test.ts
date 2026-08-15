import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ensureGitignore,
  getPromptJournalEntries,
  recordPromptJournalEntry,
} from '../src/index.js';

describe('Hierarchical Prompt Journal & Trace Logger', () => {
  it('automatically adds .wrongstack/ to .gitignore if not present', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pj-git-'));
    const gitignorePath = path.join(tempDir, '.gitignore');

    try {
      await fs.writeFile(gitignorePath, 'node_modules/\ndist/\n', 'utf8');
      await ensureGitignore(tempDir);

      const updated = await fs.readFile(gitignorePath, 'utf8');
      expect(updated).toContain('.wrongstack/');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('records prompts hierarchically into YYYY-MM/YYYY-MM-DD folders with index.json and index.md', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pj-hier-'));
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);

    try {
      // 1. Raw User Prompt in Session A
      const entry1 = await recordPromptJournalEntry({
        projectRoot: tempDir,
        sessionId: 'sess_auth',
        category: 'raw_user',
        content: 'Kullanıcı tablosuna telefon numarası ekle',
        model: 'gemini-2.5-pro',
        provider: 'google',
      });

      expect(entry1.id).toBeDefined();
      expect(entry1.category).toBe('raw_user');
      expect(entry1.sessionId).toBe('sess_auth');

      // 2. Refined Prompt in Session A
      await recordPromptJournalEntry({
        projectRoot: tempDir,
        sessionId: 'sess_auth',
        category: 'refined_user',
        rawContent: 'Kullanıcı tablosuna telefon numarası ekle',
        content:
          '[Context: PostgreSQL Prisma Schema]\nUser requested: Add phone number to User table.\nConvention: Use E.164 string format with unique index.',
        model: 'gemini-2.5-pro',
        activeTools: ['codebase-skeleton', 'codebase-ast-replace'],
        decisionReason: 'Autonomous best practice: E.164 format with unique index',
      });

      // 3. Autonomous Prompt in Session B
      await recordPromptJournalEntry({
        projectRoot: tempDir,
        sessionId: 'sess_billing',
        category: 'autonomous_next_step',
        content: 'Running codebase-targeted-test for stripe webhook handler.',
        activeTools: ['codebase-targeted-test'],
      });

      // Check directory hierarchy
      const promptsBase = path.join(tempDir, '.wrongstack', 'prompts');
      const dayDir = path.join(promptsBase, month, today);

      // Root index files
      const indexJsonExists = await fs.stat(path.join(promptsBase, 'index.json')).then(() => true).catch(() => false);
      const indexMdExists = await fs.stat(path.join(promptsBase, 'index.md')).then(() => true).catch(() => false);
      expect(indexJsonExists).toBe(true);
      expect(indexMdExists).toBe(true);

      const indexMdContent = await fs.readFile(path.join(promptsBase, 'index.md'), 'utf8');
      expect(indexMdContent).toContain('Prompt Journal Navigation Index');
      expect(indexMdContent).toContain('sess_auth');
      expect(indexMdContent).toContain('sess_billing');

      // Daily files
      const sessionAJsonl = await fs.stat(path.join(dayDir, 'session-sess_auth.jsonl')).then(() => true).catch(() => false);
      const sessionAMd = await fs.stat(path.join(dayDir, 'session-sess_auth.md')).then(() => true).catch(() => false);
      const dailySummary = await fs.stat(path.join(dayDir, 'daily-summary.md')).then(() => true).catch(() => false);

      expect(sessionAJsonl).toBe(true);
      expect(sessionAMd).toBe(true);
      expect(dailySummary).toBe(true);

      const sessionAMdContent = await fs.readFile(path.join(dayDir, 'session-sess_auth.md'), 'utf8');
      expect(sessionAMdContent).toContain('**Category:** `raw_user`');
      expect(sessionAMdContent).toContain('**Category:** `refined_user`');

      // Read entries back via query helper
      const allEntries = await getPromptJournalEntries(tempDir);
      expect(allEntries.length).toBe(3);

      const sessionBEntries = await getPromptJournalEntries(tempDir, { sessionId: 'sess_billing' });
      expect(sessionBEntries.length).toBe(1);
      expect(sessionBEntries[0]?.category).toBe('autonomous_next_step');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('keeps slash-containing session ids filename-safe while preserving them in entries', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pj-slash-'));
    const today = new Date().toISOString().slice(0, 10);
    const month = today.slice(0, 7);
    const sessionId = '2026-08-14/sess_01JX2S9V7T5M6N7P8Q9R0STXVW';
    const leaf = 'sess_01JX2S9V7T5M6N7P8Q9R0STXVW';

    try {
      await recordPromptJournalEntry({
        projectRoot: tempDir,
        sessionId,
        category: 'raw_user',
        content: 'slash session entry',
      });

      const promptsBase = path.join(tempDir, '.wrongstack', 'prompts');
      const dayDir = path.join(promptsBase, month, today);

      // Files land as session-<leaf> — the slash must NOT create a nested dir.
      const jsonlExists = await fs
        .stat(path.join(dayDir, `session-${leaf}.jsonl`))
        .then(() => true)
        .catch(() => false);
      const mdExists = await fs
        .stat(path.join(dayDir, `session-${leaf}.md`))
        .then(() => true)
        .catch(() => false);
      expect(jsonlExists).toBe(true);
      expect(mdExists).toBe(true);

      // No nested `session-<date>/` subdirectory was created.
      const nested = await fs
        .stat(path.join(dayDir, 'session-2026-08-14'))
        .then(() => true)
        .catch(() => false);
      expect(nested).toBe(false);

      // The reader resolves the full (slash-containing) session id...
      const byId = await getPromptJournalEntries(tempDir, { sessionId });
      expect(byId).toHaveLength(1);
      expect(byId[0]?.sessionId).toBe(sessionId);
      expect(byId[0]?.content).toBe('slash session entry');

      // ...and its leaf form, since both sides are normalized.
      const byLeaf = await getPromptJournalEntries(tempDir, { sessionId: leaf });
      expect(byLeaf).toHaveLength(1);
      expect(byLeaf[0]?.sessionId).toBe(sessionId);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
