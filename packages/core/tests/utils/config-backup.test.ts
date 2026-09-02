import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { backupConfigFile, configHistoryDir, configSlug } from '../../src/utils/config-backup.js';

describe('config-backup', () => {
  let tmpDir: string;
  let globalRoot: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'config-backup-test-'));
    globalRoot = path.join(tmpDir, '.wrongstack');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('configSlug', () => {
    it('derives slug for top-level config.json', () => {
      const p = path.join(globalRoot, 'config.json');
      expect(configSlug(p, globalRoot)).toBe('config');
    });

    it('derives slug for profile config.json', () => {
      const p = path.join(globalRoot, 'profiles', 'work', 'config.json');
      expect(configSlug(p, globalRoot)).toBe('profiles-work-config');
    });

    it('sanitizes Windows drive letters and colons across drives', () => {
      const slug = configSlug(
        'D:\\Codebox\\PROJECTS\\.wrongstack\\config.json',
        'C:\\Users\\admin\\.wrongstack',
      );
      expect(slug).not.toContain(':');
      expect(slug).not.toContain('\\');
      expect(slug).not.toContain('/');
    });
  });

  describe('backupConfigFile', () => {
    it('creates a backup of an existing config file', async () => {
      const configFile = path.join(globalRoot, 'config.json');
      await fs.mkdir(globalRoot, { recursive: true });
      await fs.writeFile(configFile, JSON.stringify({ model: 'claude-3-5-sonnet' }));

      await backupConfigFile(configFile, { globalRoot });

      const historyDir = configHistoryDir(globalRoot);
      const files = await fs.readdir(historyDir);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^config-\d{4}-\d{2}-\d{2}T.*\.json$/);

      const content = await fs.readFile(path.join(historyDir, files[0]!), 'utf8');
      expect(JSON.parse(content)).toEqual({ model: 'claude-3-5-sonnet' });
    });

    it('silently ignores missing or empty files', async () => {
      const nonExistent = path.join(globalRoot, 'does-not-exist.json');
      await backupConfigFile(nonExistent, { globalRoot });

      const historyDir = configHistoryDir(globalRoot);
      await expect(fs.readdir(historyDir)).rejects.toThrow();
    });
  });
});
