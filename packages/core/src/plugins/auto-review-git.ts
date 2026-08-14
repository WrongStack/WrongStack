import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

export interface ChangedFile {
  path: string;
  status: 'added' | 'modified';
}

export interface ChangedFileSnapshot extends ChangedFile {
  content: string;
  fingerprint: string;
}

export const MAX_SNAPSHOT_FILE_BYTES = 256 * 1024;
export const MAX_SNAPSHOT_TOTAL_BYTES = 8 * 1024 * 1024;

export async function runGit(
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn('git', args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        signal: AbortSignal.timeout(15_000),
        windowsHide: true,
      });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => {
      stdout += d;
    });
    child.stderr?.on('data', (d) => {
      stderr += d;
    });
    child.on('error', () => resolve({ stdout, stderr, code: 1 }));
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await runGit(['rev-parse', '--git-dir'], cwd);
  return r.code === 0;
}

export async function getChangedFiles(cwd: string): Promise<ChangedFile[]> {
  const r = await runGit(['status', '--porcelain', '--untracked-files=no'], cwd);
  if (r.code !== 0) return [];
  const files: ChangedFile[] = [];
  for (const line of r.stdout.split('\n')) {
    if (!line.trim()) continue;
    const x = line[0] ?? ' ';
    const y = line[1] ?? ' ';
    const rawPath = line.slice(3).trim();
    const filePath =
      x === 'R' || x === 'C' ? (rawPath.split(' -> ').pop()?.trim() ?? rawPath) : rawPath;
    if (x === 'A' || y === 'A') {
      files.push({ path: filePath, status: 'added' });
    } else if (x === 'M' || y === 'M' || x === 'R' || x === 'C') {
      files.push({ path: filePath, status: 'modified' });
    }
  }
  return files;
}

export async function snapshotChangedFiles(cwd: string): Promise<ChangedFileSnapshot[]> {
  const snapshots: ChangedFileSnapshot[] = [];
  let budget = MAX_SNAPSHOT_TOTAL_BYTES;
  for (const file of await getChangedFiles(cwd)) {
    if (file.path.startsWith('.wrongstack/')) continue;
    if (budget <= 0) break;
    try {
      const stat = await fsp.stat(path.join(cwd, file.path));
      if (!stat.isFile() || stat.size > MAX_SNAPSHOT_FILE_BYTES) continue;
      const content = await fsp.readFile(path.join(cwd, file.path), 'utf8');
      budget -= content.length;
      snapshots.push({
        ...file,
        content,
        fingerprint: createHash('sha256').update(content).digest('hex'),
      });
    } catch {
      // File deleted, unreadable, or not a regular UTF-8 file — skip it.
    }
  }
  return snapshots;
}
