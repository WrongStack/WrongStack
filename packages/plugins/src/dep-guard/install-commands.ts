// ---------------------------------------------------------------------------
// Install-command parsing
// ---------------------------------------------------------------------------

export interface ParsedInstall {
  manager: string;
  packages: Array<{ name: string; version: string | null }>;
}

/**
 * Where a command can START.
 *
 * Probe-verified gap (2026-09-22): this was `(?:^|[;&|]\s*)`, which knows
 * neither a NEWLINE nor shell grouping. A multi-line bash script -- the
 * ordinary shape for anything with more than one step -- put every install
 * after the first out of reach, and `(npm i x)` / `{ npm i x; }` were never
 * seen at all. 10 of 16 probed install forms parsed to zero packages.
 */
const CMD_BOUNDARY = String.raw`(?:^|[;&|(){}\n\r]\s*)`;

/**
 * Launchers that run the package manager for you, and an optional path
 * prefix. `sudo npm install evil` was the single most obvious miss: the
 * manager has to sit at a command boundary, and `sudo ` is not one.
 *
 * Each launcher may carry flags, env assignments and a numeric operand
 * (`timeout 60 npm i x`) — fractional too: GNU timeout takes `1.5m` / `.5`,
 * and an integer-only operand left `timeout 1.5m npm i x` unparsed (no check
 * ran at all). The three inner alternatives are mutually exclusive
 * by first character and none can begin a launcher word, so the nesting
 * cannot fork the parse; the run is bounded at 4.
 */
const LAUNCHER_PREFIX = String.raw`(?:(?:sudo|doas|nohup|setsid|timeout|time|nice|ionice|stdbuf|unbuffer|command|exec|env|xargs)\b(?:\s+(?:-[^\s]+|[A-Za-z_][A-Za-z0-9_]*=[^\s]*|(?:\d+(?:\.\d*)?|\.\d+)[smhd]?))*\s+){0,4}`;
const MANAGER_PREFIX = String.raw`(?:[^\s;&|(){}]+[\\/])?`;

/**
 * Everything up to the next command boundary. Newlines end an arg run, and so
 * do the grouping closers: without `)` the subshell form `(npm i evil-pkg)`
 * parsed the package as `evil-pkg)`, which matches no deny entry and no
 * typosquat neighbour. No npm/pip/cargo package or version spec contains
 * either character.
 */
const ARGS = String.raw`([^;&|\n\r)}]+)`;

/**
 * Leading `NAME=value` assignments scope the environment to one command
 * (`NODE_ENV=production npm i x`); like a launcher, they must not hide the
 * manager from the boundary.
 */
const ENV_PREFIX = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=[^\s;&|(){}]*\s+){0,4}`;

const START = `${CMD_BOUNDARY}${ENV_PREFIX}${LAUNCHER_PREFIX}${MANAGER_PREFIX}`;

/**
 * npm's install verb and the aliases npm itself accepts (`npm in`,
 * `npm isntall` …): only `install|i|add` were known, so every alias installed
 * unchecked.
 */
const JS_INSTALL_VERB = '(?:install|i|add|in|ins|inst|insta|instal|isnt|isnta|isntal|isntall)';

/**
 * Global options between a JS package manager and its verb, each with an
 * optional value: `pnpm --filter app add x`, `npm -w pkg i x`, `pnpm -C dir
 * add x`, `yarn --cwd dir add x`. Requiring the verb right after the manager
 * name made every monorepo spelling invisible to dep-guard. The value may not
 * start with `-` nor be a verb, so option/value/verb never compete (no
 * backtracking fork).
 */
const PM_WORD = String.raw`[^\s;&|(){}]`;
const PM_OPTIONS = String.raw`(?:\s+-${PM_WORD}*(?:\s+(?!-)(?!(?:${JS_INSTALL_VERB}|global|workspace)\b)${PM_WORD}+)?)*`;

// `global` covers `yarn global add` / `npm install global`-style invocations,
// which the previous pattern could not reach because it required the
// subcommand to sit immediately after the manager name. `workspace <name>`
// is yarn's per-package form (`yarn workspace app add x`).
const INSTALL_RE = new RegExp(
  [
    // `.cmd`/`.exe`/`.ps1`: the Windows shim names of the same managers.
    String.raw`${START}(npm|pnpm|yarn|bun)(?:\.cmd|\.exe|\.ps1)?${PM_OPTIONS}\s+(?:global\s+|workspace\s+${PM_WORD}+\s+)?${JS_INSTALL_VERB}\s+${ARGS}`,
    String.raw`${START}(pip3?|uv)(?:\.exe)?\s+(?:pip\s+)?install\s+${ARGS}`,
    String.raw`${START}(uv)\s+add\s+${ARGS}`,
    String.raw`${START}(cargo)\s+add\s+${ARGS}`,
    // `python -m pip install` — pip's own recommended invocation.
    String.raw`${START}(?:python[0-9.]*|py)(?:\.exe)?(?:\s+-(?!m\b)${PM_WORD}+)*\s+-m\s*(pip3?)\s+install\s+${ARGS}`,
  ].join('|'),
  'gi',
);

/**
 * A JS install that names no package — `npm install`, `npm i`, `npm ci`,
 * `pnpm install`, `bun install`, bare `yarn` / `yarn install`. It restores or
 * re-resolves the whole tree from package.json, so tree-wide checks (the
 * vulnerability audit) apply to it; INSTALL_RE needs an argument and never
 * reports these. Bare `yarn` takes value-less options only, so `yarn -s build`
 * stays a script run.
 */
const TREE_INSTALL_RE = new RegExp(
  [
    String.raw`${START}(?:npm|pnpm|bun)${PM_OPTIONS}\s+(?:install|i)\s*(?=$|[;&|(){}\n\r])`,
    String.raw`${START}yarn(?:${PM_OPTIONS}\s+install|(?:\s+-${PM_WORD}+)*)\s*(?=$|[;&|(){}\n\r])`,
    String.raw`${START}npm${PM_OPTIONS}\s+(?:ci|clean-install)(?=\s|$|[;&|(){}\n\r])`,
  ].join('|'),
  'i',
);

/** True when `command` runs a package-less JS install (see TREE_INSTALL_RE). */
export function isTreeInstallCommand(command: string): boolean {
  return TREE_INSTALL_RE.test(command);
}

/**
 * Options whose VALUE is the next token, per manager family. Read as package
 * names, those values became phantom dependencies — `pip install -r
 * requirements.txt` "installed" a package named `requirements.txt`, which was
 * then registry-checked and reported as a hallucinated name on the most common
 * pip command; `cargo add serde --features derive` added `derive`.
 * The `--opt=value` spelling is a single `-`-prefixed token and needs no entry.
 */
const VALUE_OPTIONS: Readonly<Record<'js' | 'pip' | 'cargo', ReadonlySet<string>>> = {
  js: new Set([
    '-w',
    '--workspace',
    '--prefix',
    '--registry',
    '--tag',
    '--cache',
    '--userconfig',
    '--filter',
    '-F',
    '--cwd',
    '-C',
    '--dir',
    '--omit',
    '--include',
    '--save-prefix',
    '--install-strategy',
  ]),
  pip: new Set([
    '-r',
    '--requirement',
    '-c',
    '--constraint',
    '-e',
    '--editable',
    '-i',
    '--index-url',
    '--extra-index-url',
    '--index',
    '-f',
    '--find-links',
    '-t',
    '--target',
    '--prefix',
    '--root',
    '--src',
    '--platform',
    '--python-version',
    '--implementation',
    '--abi',
    '--upgrade-strategy',
    '--progress-bar',
    '--log',
    '--cert',
    '--client-cert',
    '--proxy',
    '--trusted-host',
    '--no-binary',
    '--only-binary',
    '-C',
    '--config-settings',
    '-p',
    '--python',
    '--group',
    '--extra',
    '--optional',
  ]),
  cargo: new Set([
    '-F',
    '--features',
    '-p',
    '--package',
    '--rename',
    '--path',
    '--git',
    '--branch',
    '--tag',
    '--rev',
    '--registry',
    '--manifest-path',
    '--target',
    '--lockfile-path',
    '--color',
    '--config',
    '-Z',
  ]),
};

function valueOptionsFor(manager: string): ReadonlySet<string> {
  if (manager === 'cargo') return VALUE_OPTIONS.cargo;
  if (manager === 'pip' || manager === 'pip3' || manager === 'uv') return VALUE_OPTIONS.pip;
  return VALUE_OPTIONS.js;
}

/** Package managers whose specs may carry PEP 508 extras: `evil-pkg[security]`. */
const EXTRAS_MANAGERS: ReadonlySet<string> = new Set(['pip', 'pip3', 'uv']);

/**
 * Extras are not part of the distribution name: `pip install evil-pkg[security]`
 * installs `evil-pkg[security]`. Kept in the name, every name-keyed check
 * (deny/allow, typosquat, registry lookup, license audit) compared against a
 * spelling no config entry contains — a deny-list bypass in block mode.
 */
function withoutExtras(name: string, manager: string): string {
  return EXTRAS_MANAGERS.has(manager) ? name.replace(/\[[^\]]*\]$/, '') : name;
}

/**
 * Parse a shell command for dependency installs. Returns one entry
 * per install segment found (compound commands can contain several).
 * Bare `npm install` (restore from lockfile, no packages) yields an
 * empty package list and is NOT treated as adding dependencies.
 */
export function parseInstallCommands(command: string): ParsedInstall[] {
  const out: ParsedInstall[] = [];
  INSTALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null = INSTALL_RE.exec(command);
  while (m !== null) {
    const manager = (m[1] ?? m[3] ?? m[5] ?? m[7] ?? m[9] ?? '').toLowerCase();
    const argString = m[2] ?? m[4] ?? m[6] ?? m[8] ?? m[10] ?? '';
    const packages: ParsedInstall['packages'] = [];
    const valueOptions = valueOptionsFor(manager);
    let skipValue = false;
    for (const token of argString.split(/\s+/)) {
      if (!token) continue;
      if (skipValue) {
        skipValue = false;
        continue;
      }
      if (token.startsWith('-')) {
        skipValue = valueOptions.has(token);
        continue;
      }
      // Skip local paths / URLs / archives.
      if (/^(\.|\/|file:|git\+|https?:)/i.test(token) || token.endsWith('.tgz')) continue;
      // An npm alias spec installs the package after `npm:` under another name
      // (`npm:evil`, `local-name@npm:evil@1`); the alias hid it from every check.
      const quoted = token.replace(/^['"]|['"]$/g, '');
      const cleaned = /(?:^|@)npm:(.+)$/.exec(quoted)?.[1] ?? quoted;
      if (!cleaned) continue;
      // npm-style version suffix: name@ver (careful with @scope/name@ver);
      // pip-style: name==ver / name>=ver.
      let name = cleaned;
      let version: string | null = null;
      const pipMatch = /^([A-Za-z0-9_.-]+(?:\[[^\]]+\])?)\s*(==|>=|<=|~=|!=|>|<)\s*(.+)$/.exec(
        cleaned,
      );
      if (pipMatch?.[1]) {
        name = pipMatch[1];
        const op = pipMatch[2] ?? '';
        const ver = (pipMatch[3] ?? '').trim();
        // `==` is the historical pip pin spelling; keep the bare version.
        // Range operators stay attached so `>=1.0` is distinguishable from `1.0`.
        version = op === '==' || op === '' ? ver || null : `${op}${ver}`;
      } else {
        const at = cleaned.lastIndexOf('@');
        if (at > 0) {
          name = cleaned.slice(0, at);
          version = cleaned.slice(at + 1) || null;
        }
      }
      const bare = withoutExtras(name, manager);
      if (bare) packages.push({ name: bare, version });
    }
    out.push({ manager, packages });
    m = INSTALL_RE.exec(command);
  }
  return out;
}
