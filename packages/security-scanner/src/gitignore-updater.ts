import { readFile } from 'node:fs/promises';
import { atomicWrite } from '@wrongstack/core/utils';

export interface GitignoreUpdaterOptions {
  gitignorePath: string;
  entries: string[];
}

const DEFAULT_OPTIONS: GitignoreUpdaterOptions = {
  gitignorePath: '.gitignore',
  entries: ['security-reports/', 'security-reports/*'],
};

export class GitignoreUpdater {
  private options: GitignoreUpdaterOptions;

  constructor(options: Partial<GitignoreUpdaterOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async update(): Promise<{ added: string[]; existing: string[]; errors: string[] }> {
    const added: string[] = [];
    const existing: string[] = [];
    const errors: string[] = [];

    try {
      const content = await readFile(this.options.gitignorePath, 'utf-8');
      const lines = new Set(content.split(/\r?\n/).map((l) => l.trim()));

      const toAdd: string[] = [];
      const uniqueEntries = [...new Set(this.options.entries.map((e) => e.trim()).filter(Boolean))];
      for (const entry of uniqueEntries) {
        if (lines.has(entry)) {
          existing.push(entry);
        } else {
          lines.add(entry);
          toAdd.push(entry);
        }
      }

      if (toAdd.length > 0) {
        // Append only: rebuilding from the de-duplicated set dropped blank
        // lines, repeated comments and CRLF, and — .gitignore being
        // last-match-wins — a pattern repeated after a negation, which
        // un-ignored files the user had ignored.
        const eol = content.includes('\r\n') ? '\r\n' : '\n';
        const separator = content === '' || content.endsWith('\n') ? '' : eol;
        const newContent = content + separator + toAdd.join(eol) + eol;
        // atomicWrite: .gitignore is a user-tracked source file — a torn
        // write here would commit a corrupt file to the user's repo.
        await atomicWrite(this.options.gitignorePath, newContent);
        added.push(...toAdd);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        try {
          // .gitignore doesn't exist, create it with deduplicated trimmed entries
          const uniqueEntries = [
            ...new Set(this.options.entries.map((e) => e.trim()).filter(Boolean)),
          ];
          const content = uniqueEntries.length > 0 ? `${uniqueEntries.join('\n')}\n` : '';
          await atomicWrite(this.options.gitignorePath, content);
          added.push(...uniqueEntries);
        } catch (writeErr) {
          errors.push(`Failed to update .gitignore: ${writeErr}`);
        }
      } else {
        errors.push(`Failed to update .gitignore: ${err}`);
      }
    }

    return { added, existing, errors };
  }

  async isEntryIgnored(entry: string): Promise<boolean> {
    try {
      const content = await readFile(this.options.gitignorePath, 'utf-8');
      const lines = content.split(/\r?\n/).map((l) => l.trim());
      return lines.includes(entry.trim());
    } catch {
      return false;
    }
  }
}

export const defaultGitignoreUpdater = new GitignoreUpdater();
