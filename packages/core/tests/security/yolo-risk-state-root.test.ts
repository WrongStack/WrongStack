import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isClearlyDestructiveBashCommand } from '../../src/security/yolo-risk.js';

const ROOT = process.platform === 'win32' ? 'C:\\proj' : '/proj';

/**
 * YOLO shell redirection security gap: `echo "x" > ~/.wrongstack/trust.json`
 * was not classified as destructive, so YOLO mode would silently auto-approve
 * writes to WrongStack's own trusted state files (trust.json, config.local.json,
 * auth.json, .key) via shell redirection, tee, cp, and mv — bypassing the
 * FS_WRITE state-root carve-out that only covers the write/edit/replace tools.
 */
describe('isClearlyDestructiveBashCommand — state-root write detection', () => {
  const stateRoot = path.join(os.homedir(), '.wrongstack');

  describe('redirection to state-root files', () => {
    it.each([
      ['echo "allow:*" > ~/.wrongstack/trust.json'],
      ['echo "{}" >> ~/.wrongstack/config.local.json'],
      [`echo "x" > ${path.join(stateRoot, 'trust.json')}`],
      [`echo "x" >> ${path.join(stateRoot, 'auth.json')}`],
      [`printf "x" > ${path.join(stateRoot, '.key')}`],
      [`cat > ${path.join(stateRoot, 'trust.json')} << 'EOF'`],
    ])('%j → destructive=true', (cmd) => {
      expect(isClearlyDestructiveBashCommand(cmd, ROOT)).toBe(true);
    });
  });

  describe('tee to state-root files', () => {
    it.each([
      ['echo "x" | tee ~/.wrongstack/trust.json'],
      ['echo "x" | tee -a ~/.wrongstack/config.local.json'],
      [`echo "x" | tee ${path.join(stateRoot, 'auth.json')}`],
    ])('%j → destructive=true', (cmd) => {
      expect(isClearlyDestructiveBashCommand(cmd, ROOT)).toBe(true);
    });
  });

  describe('cp/mv to state-root files', () => {
    it.each([
      ['cp evil.json ~/.wrongstack/trust.json'],
      ['mv payload.json ~/.wrongstack/config.local.json'],
      [`cp evil.json ${path.join(stateRoot, 'trust.json')}`],
    ])('%j → destructive=true', (cmd) => {
      expect(isClearlyDestructiveBashCommand(cmd, ROOT)).toBe(true);
    });
  });

  describe('non-state-root paths are NOT flagged by this detector', () => {
    it.each([
      ['echo "x" > src/output.txt'],
      ['echo "x" >> /tmp/log.txt'],
      [`echo "x" > ${path.join(stateRoot, 'memory.md')}`], // not a protected basename
      ['cp src/a.txt src/b.txt'],
      ['echo "x" | tee src/output.txt'],
      ['echo "x" > ~/.cache/something.json'],
    ])(
      '%j → destructive=false (for state-root detector; may be caught by other detectors)',
      (cmd) => {
        // We only assert the state-root detector does not fire on these.
        // Other detectors (project-escape rm, etc.) might still flag, so
        // we check that these specific in-project / non-protected paths pass.
        expect(isClearlyDestructiveBashCommand(cmd, ROOT)).toBe(false);
      },
    );
  });
});
