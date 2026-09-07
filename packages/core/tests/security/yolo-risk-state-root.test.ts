import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isClearlyDestructiveBashCommand } from '../../src/security/yolo-risk.js';
import { wstackGlobalRoot } from '../../src/utils/wstack-paths.js';

const ROOT = process.platform === 'win32' ? 'C:\\proj' : '/proj';
// Mirror wstackGlobalRoot() so plugin-root expectations track the same
// override the production code uses (vitest setup pins WRONGSTACK_HOME to
// a temp dir; os.homedir() does not reflect that).
const stateRoot = wstackGlobalRoot();

/**
 * YOLO shell redirection security gap: `echo "x" > ~/.wrongstack/trust.json`
 * was not classified as destructive, so YOLO mode would silently auto-approve
 * writes to WrongStack's own trusted state files (trust.json, config.local.json,
 * auth.json, .key) via shell redirection, tee, cp, and mv — bypassing the
 * FS_WRITE state-root carve-out that only covers the write/edit/replace tools.
 */
describe('isClearlyDestructiveBashCommand — state-root write detection', () => {
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

  // Regression for H-3 (CMDI-001): the previous token-based redirect scan
  // only matched `>` / `>>` as standalone tokens. Glued forms — `>~`,
  // `>>~`, `&>~`, `2>~`, `>>|~` — were invisible to the classifier and let
  // an injected `bash` call write blanket `auto` entries into `trust.json`
  // (which survive a later YOLO-off because `permission-policy.ts:341`
  // returns `{permission:'auto', source:'trust'}` before the YOLO gate).
  describe('glued write-redirect forms to state-root files', () => {
    it.each([
      // tilde-prefixed, no space — the bypass the hunter documented
      ['echo x >~/.wrongstack/trust.json'],
      ['echo x >>~/.wrongstack/config.local.json'],
      // absolute path, no space
      [`echo x >${path.join(stateRoot, 'trust.json')}`],
      [`echo x >>${path.join(stateRoot, 'auth.json')}`],
      // bash 4+ `&>` / `&>>` (fd-redirect to file)
      ['echo x &>~/.wrongstack/trust.json'],
      ['echo x &>>~/.wrongstack/config.json'],
      // fd-specific `2>` / `2>>`
      ['echo x 2>~/.wrongstack/.key'],
      ['echo x 2>>~/.wrongstack/auth.json'],
      // noclobber-override `>|` / `>>|`
      ['echo x >|~/.wrongstack/trust.json'],
      ['echo x >>|~/.wrongstack/config.local.json'],
    ])('%j → destructive=true', (cmd) => {
      expect(isClearlyDestructiveBashCommand(cmd, ROOT)).toBe(true);
    });
  });

  // Belt-and-braces: glued redirect forms whose target is NOT in the state
  // root must not be flagged by THIS detector. (Other detectors may fire on
  // them, but the state-root detector should stay narrow.) Use paths that
  // are outside the wstack root AND not on any other catastrophic list, so
  // a clean false is unambiguous.
  describe('glued redirects to non-state-root paths are not flagged here', () => {
    it.each([
      ['echo x &>~/somewhere/else.json'],
      ['echo x &>~/random-file.txt'],
    ])('%j → destructive=false (state-root detector must not fire)', (cmd) => {
      expect(isClearlyDestructiveBashCommand(cmd, ROOT)).toBe(false);
    });
  });

  // Regression for H-4 (RCE-002): a bash write into the global plugin
  // root (`~/.wrongstack/plugins/x.mjs`) is auto-approved because the
  // shell-side write guard's protected-basenames list does not include
  // the plugins directory, and the global plugin root ships with
  // `defaultState: 'active'` (vs. the project-local root's `inactive`).
  // The TOFU gate then pins the new file with no prompt, so the next
  // `wstack` launch runs `setup(api)` in-process before any tool policy
  // exists — boot-time RCE that survives the user turning YOLO off.
  // Paths use the test's effective `wstackGlobalRoot()` rather than the
  // literal `~/.wrongstack` form: in production, `~` expands to the home
  // directory, but if the user has set WRONGSTACK_HOME the trusted root
  // moves with it, and the detector must track the live wstack root.
  describe('writes into the global plugin root are destructive', () => {
    const pluginsRoot = path.join(stateRoot, 'plugins');
    it.each([
      [`echo "x" > ${path.join(pluginsRoot, 'evil.mjs')}`],
      [`echo "x" >> ${path.join(pluginsRoot, 'evil.mjs')}`],
      // entry-name without .mjs extension — the loader accepts bare
      // .js / .cjs / .ts entrypoints too
      [`echo "x" > ${path.join(pluginsRoot, 'evil.js')}`],
      // nested subdirectory — a plugin closure is more than one file
      [`echo "x" > ${path.join(pluginsRoot, 'nested', 'helper.cjs')}`],
      // tee
      [`echo "x" | tee ${path.join(pluginsRoot, 'evil.mjs')}`],
      // cp into the plugin root
      [`cp evil.mjs ${pluginsRoot}/`],
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
