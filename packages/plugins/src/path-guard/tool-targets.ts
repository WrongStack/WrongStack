import {
  effectiveToolCwd,
  isDirectoryAmbiguousPath,
  isRootPathScope,
  isUnresolvedPathScope,
  normalizePath,
  relativeToInvocationCwd,
  resolveTargetPath,
  type WriteTarget,
} from './glob.js';

export const WRITE_CAPABILITIES = new Set(['fs.write', 'fs.write.outside-project']);
export const DISK_MUTATING_CAPABILITIES = new Set(['package.install']);
export const SHELL_CAPABILITIES = new Set(['shell.arbitrary', 'shell.restricted', 'shell.exec']);
export const LEGACY_SHELL_TOOLS = new Set(['bash', 'shell', 'exec']);

export const LEGACY_WRITE_TOOLS = new Set([
  'write',
  'edit',
  'patch',
  'scaffold',
  'format',
  'replace',
  'design',
  'install',
]);

export const PATH_FIELDS = [
  'path',
  'file_path',
  'filePath',
  'target',
  'target_path',
  'targetPath',
  'destination',
  'dest',
  'output_path',
  'outputPath',
  'out',
  'file',
] as const;
export const PATH_LIST_FIELDS = ['files', 'paths'] as const;

export const SOURCE_PATH_FIELDS = [
  'source',
  'from',
  'src',
  'input_path',
  'inputPath',
  'old_path',
  'oldPath',
] as const;
export const MOVE_TOOL_NAME = /(?:^|[_.-])(move|rename)(?:$|[_.-])/i;
export const DIRECTORY_DELETE_TOOL_NAME =
  /(?:^|[_.-])(?:rmdir|(?:delete|remove)[_.-](?:dir|directory))(?:$|[_.-])/i;

export function segmentedToolName(toolName: string): string {
  return toolName.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
}

export function isMoveToolName(toolName: string): boolean {
  return MOVE_TOOL_NAME.test(segmentedToolName(toolName));
}

export function isDirectoryDeleteToolName(toolName: string): boolean {
  return DIRECTORY_DELETE_TOOL_NAME.test(segmentedToolName(toolName));
}

export function cleanPatchPath(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '/dev/null') return null;
  const quoted = /^"([^"]+)"(?:\s|$)/.exec(trimmed)?.[1];
  const withoutTimestamp =
    quoted ?? trimmed.replace(/(?:\t|\s+)\d{4}-\d{2}-\d{2}(?:\s.*)?$/, '').trim();
  if (!withoutTimestamp || withoutTimestamp === '/dev/null') return null;
  return withoutTimestamp.replace(/^[ab]\//, '');
}

export function pathsFromPatch(patch: string): string[] {
  const paths: string[] = [];
  const lines = patch.split(/\r?\n/);
  for (let index = 0; index + 2 < lines.length; index += 1) {
    const oldHeader = lines[index];
    const newHeader = lines[index + 1];
    const hunkHeader = lines[index + 2];
    if (!oldHeader?.startsWith('--- ') || !newHeader?.startsWith('+++ ')) continue;
    if (!hunkHeader?.startsWith('@@ ')) continue;
    const oldPath = cleanPatchPath(oldHeader.slice(4));
    const newPath = cleanPatchPath(newHeader.slice(4));
    if (oldPath) paths.push(oldPath);
    if (newPath) paths.push(newPath);
  }
  return paths;
}

export function appendTarget(
  targets: WriteTarget[],
  value: unknown,
  kind: WriteTarget['kind'],
  base?: string,
): void {
  if (typeof value !== 'string' || value.length === 0) return;
  targets.push({
    path: resolveTargetPath(value, base),
    kind,
  });
}

export function appendTargetList(
  targets: WriteTarget[],
  value: unknown,
  directoryCapable: boolean,
  base?: string,
): void {
  const appendPath = (path: string): void => {
    targets.push({
      path: resolveTargetPath(path, base),
      kind:
        isUnresolvedPathScope(path) ||
        isRootPathScope(path) ||
        (directoryCapable && isDirectoryAmbiguousPath(path))
          ? 'scope'
          : 'file',
    });
  };

  if (typeof value === 'string') {
    const paths = value
      .split(',')
      .map((item) => item.trim())
      .filter((path) => path.length > 0);
    for (const path of paths) appendPath(path);
    return;
  }
  if (!Array.isArray(value)) return;
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const path = item.trim();
    if (path.length > 0) appendPath(path);
  }
}

export function isReadOnlyInvocation(
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  if (toolName === 'git') {
    const command = toolInput['command'];
    if (
      command === 'status' ||
      command === 'log' ||
      command === 'diff' ||
      command === 'fetch' ||
      command === 'commit' ||
      command === 'branch' ||
      command === 'push'
    ) {
      return true;
    }
    return command === 'worktree' && toolInput['worktreeAction'] === 'list';
  }
  if (toolName === 'design') {
    const action = toolInput['action'] ?? 'list';
    return action === 'list' || action === 'foundations' || action === 'verify';
  }
  if (toolName === 'format') return toolInput['check'] === true;
  if (toolName === 'patch' || toolName === 'scaffold') return toolInput['dry_run'] === true;
  if (toolName === 'replace') return toolInput['dry_run'] !== false;
  return false;
}

export function writesToDisk(input: {
  toolName?: string | undefined;
  toolInput?: Record<string, unknown> | undefined;
  toolCapabilities?: readonly string[] | undefined;
  toolMutating?: boolean | undefined;
}): boolean {
  const capabilities = input.toolCapabilities;
  const capabilitiesUndeclared = !capabilities || capabilities.length === 0;
  const hasWriteCap =
    capabilities?.some((capability) => WRITE_CAPABILITIES.has(capability)) ?? false;
  const hasDiskMutatingCap =
    capabilities?.some((capability) => DISK_MUTATING_CAPABILITIES.has(capability)) ?? false;
  const hasCommandString = typeof input.toolInput?.['command'] === 'string';
  if (
    hasCommandString &&
    executesShell(input) &&
    !hasWriteCap &&
    !hasDiskMutatingCap &&
    !(capabilitiesUndeclared && LEGACY_WRITE_TOOLS.has(input.toolName ?? ''))
  )
    return false;
  if (!capabilitiesUndeclared) {
    if (hasWriteCap || hasDiskMutatingCap) return true;

    if (capabilities.includes('mcp.proxy')) {
      const segmentedName = (input.toolName ?? '')
        .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
        .replace(/[^a-z0-9]+/gi, '_')
        .toLowerCase();
      const filesystemWriter =
        /(?:^|_)filesystem(?:_|$)/.test(segmentedName) &&
        /(?:^|_)(?:add|append|copy|create|delete|edit|mkdir|move|remove|rename|write)(?:_|$)/.test(
          segmentedName,
        );
      const toolInput = input.toolInput ?? {};
      const hasKnownPath = [...PATH_FIELDS, ...PATH_LIST_FIELDS].some(
        (field) => toolInput[field] !== undefined,
      );
      if (filesystemWriter && hasKnownPath) return true;
    }
    return false;
  }
  if (input.toolMutating !== undefined) return input.toolMutating;
  return LEGACY_WRITE_TOOLS.has(input.toolName ?? '');
}

export function executesShell(input: {
  toolName?: string | undefined;
  toolInput?: Record<string, unknown> | undefined;
  toolCapabilities?: readonly string[] | undefined;
  toolMutating?: boolean | undefined;
}): boolean {
  const toolName = input.toolName ?? '';
  if (LEGACY_SHELL_TOOLS.has(toolName)) return true;
  if (toolName === 'git') return false;
  const segmentedName = toolName.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
  const isCommandStringRunner =
    /(?:^|[_.-])(?:command|exec|execute|shell|terminal)(?:$|[_.-])/i.test(segmentedName);
  const hasShellCapability =
    input.toolCapabilities?.some((capability) => SHELL_CAPABILITIES.has(capability)) ?? false;
  const hasCommandString = typeof input.toolInput?.['command'] === 'string';
  return (
    (isCommandStringRunner && hasShellCapability) ||
    (hasCommandString && input.toolMutating === true)
  );
}

export function pathsFromToolInput(
  toolInput: Record<string, unknown>,
  toolName: string,
  invocationCwd?: string,
): WriteTarget[] {
  const targets: WriteTarget[] = [];
  const effectiveCwd = effectiveToolCwd(toolInput['cwd'], invocationCwd);
  const directoryDelete = isDirectoryDeleteToolName(toolName);
  for (const field of PATH_FIELDS) {
    const value = toolInput[field];
    appendTarget(
      targets,
      value,
      directoryDelete
        ? 'deletion-scope'
        : typeof value === 'string' && isUnresolvedPathScope(value)
          ? 'scope'
          : 'file',
      effectiveCwd,
    );
  }
  const directoryCapableLists = toolName === 'format' || toolName === 'replace';
  for (const field of PATH_LIST_FIELDS) {
    appendTargetList(
      targets,
      toolInput[field],
      directoryCapableLists && field === 'files',
      effectiveCwd,
    );
  }

  if (toolName === 'install') {
    appendTarget(targets, effectiveCwd ?? invocationCwd ?? '.', 'scope');
  }

  if (toolName === 'git') {
    const command = toolInput['command'];
    if (
      command === 'worktree' &&
      (toolInput['worktreeAction'] === 'add' || toolInput['worktreeAction'] === 'remove')
    ) {
      appendTarget(targets, toolInput['worktreePath'] ?? toolInput['worktree_path'], 'file');
    }
  }

  if (toolName === 'scaffold') {
    const cwdValue = toolInput['cwd'];
    const cwd =
      typeof cwdValue === 'string' && cwdValue.length > 0 ? cwdValue : (invocationCwd ?? '.');
    const base = normalizePath(cwd).replace(/\/$/, '');
    const name = typeof toolInput['name'] === 'string' ? toolInput['name'] : '';
    const template = toolInput['template'];
    const filesByTemplate: Record<string, string[]> = {
      'npm-package': ['package.json', 'tsconfig.json', 'src/index.ts', 'src/index.test.ts'],
      'cli-tool': ['package.json', 'src/index.ts'],
      'react-component': name ? [`${name}.tsx`, `${name}.test.tsx`] : [],
    };
    for (const file of typeof template === 'string' ? (filesByTemplate[template] ?? []) : []) {
      targets.push({ path: `${base}/${file}`, kind: 'file' });
    }
    targets.push({ path: base, kind: 'scope' });
  }

  if (isMoveToolName(toolName)) {
    for (const field of SOURCE_PATH_FIELDS) {
      appendTarget(targets, toolInput[field], 'deletion-scope', effectiveCwd);
    }
  }

  const patch = toolInput['patch'];
  if (typeof patch === 'string') {
    const patchTargets = pathsFromPatch(patch);
    const directory = toolInput['directory'];
    const baseValue =
      typeof directory === 'string' && directory.length > 0 ? directory : invocationCwd;
    if (baseValue) {
      const base = normalizePath(baseValue).replace(/\/$/, '');
      targets.push(
        ...patchTargets.map((target) => ({ path: `${base}/${target}`, kind: 'file' as const })),
      );
    } else {
      targets.push(...patchTargets.map((path) => ({ path, kind: 'file' as const })));
    }
  }

  if (targets.length === 0) {
    const cwd = effectiveCwd ?? '.';
    targets.push({ path: normalizePath(cwd).replace(/\/$/, '') || '.', kind: 'scope' });
  }

  const seen = new Set<string>();
  return targets
    .map((target) => ({
      ...target,
      path: relativeToInvocationCwd(target.path, invocationCwd),
    }))
    .filter((target) => {
      const key = `${target.kind}:${target.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function operationLabel(toolName: string): string {
  if (toolName === 'write') return 'write';
  if (toolName === 'edit') return 'edit';
  return `write via "${toolName}"`;
}
