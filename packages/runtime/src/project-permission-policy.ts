import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Config, DirectoryPolicy, Tool } from '@wrongstack/contracts/types';
import {
  DefaultPermissionPolicy,
  DirectoryPermissionPolicy,
  resolveYoloConfirmKinds,
  validateDirectoryPolicy,
} from '@wrongstack/core/security';

export interface ProjectPermissionOptions {
  yolo?: boolean | undefined;
  /** `--allowed-tools`: in-memory tool-scope pre-approvals (see DefaultPermissionPolicy). */
  launchAllowedTools?: readonly string[] | undefined;
  promptDelegate?: (
    tool: Tool,
    input: unknown,
    suggestedPattern: string,
  ) => Promise<
    'yes' | 'no' | 'always' | 'always-exact' | 'always-command' | 'always-tool' | 'deny'
  >;
}

/**
 * `.wrongstack/directory-rules.json` of a project. A missing file is an empty
 * policy; an invalid one throws, so a broken rule file never silently turns
 * into "no rules".
 */
function loadDirectoryPolicy(projectRoot: string): DirectoryPolicy {
  const file = path.join(projectRoot, '.wrongstack', 'directory-rules.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    // A Windows editor saves the file with a UTF-8 BOM, which JSON.parse rejects.
    const validation = validateDirectoryPolicy(
      JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw),
    );
    if (!validation.ok) {
      throw new Error(validation.diagnostics.map((d) => `${d.path}: ${d.message}`).join('; '));
    }
    return validation.policy;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, rules: [] };
    throw new Error(
      `Invalid directory permission policy at ${file}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
}

/**
 * The permission policy a project's agent runs under: directory rules
 * wrapped around the trust-file policy, with YOLO's still-confirm kinds from
 * the user's config.
 *
 * One builder for the runtime and for `wstack permissions explain`. The
 * explainer used to assemble its own bare `DefaultPermissionPolicy`, so it
 * left out the directory rules and `autonomy.yoloConfirm` and took YOLO only
 * from its own flag: it could call a write "confirm" that the agent was
 * about to perform unasked, or one a directory rule would refuse.
 *
 * The directory rules are read when this is called, so an invalid rule file
 * fails here rather than on the first tool call.
 */
export function createProjectPermissionPolicy(opts: {
  projectRoot: string;
  trustFile: string;
  config: Config;
  permission?: ProjectPermissionOptions | undefined;
}): () => DirectoryPermissionPolicy {
  const directoryPolicy = loadDirectoryPolicy(opts.projectRoot);
  return () => {
    const policyOptions: ConstructorParameters<typeof DefaultPermissionPolicy>[0] = {
      trustFile: opts.trustFile,
      yolo: opts.permission?.yolo ?? false,
      // YOLO+ from the user's own config (in-project and cloud-synced config
      // cannot carry it). Implies YOLO.
      yoloPlus: opts.config.autonomy?.yoloPlus === true,
      // Which kinds of damage still prompt under YOLO. Read from the user's
      // profile config; an absent map gates every kind (fail-closed), and the
      // in-project loader strips `autonomy.yoloConfirm` so a repo cannot widen it.
      yoloConfirmKinds: resolveYoloConfirmKinds(opts.config.autonomy?.yoloConfirm),
    };
    if (opts.permission?.promptDelegate !== undefined) {
      policyOptions.promptDelegate = opts.permission.promptDelegate;
    }
    if (opts.permission?.launchAllowedTools !== undefined) {
      policyOptions.launchAllowedTools = opts.permission.launchAllowedTools;
    }
    return new DirectoryPermissionPolicy(new DefaultPermissionPolicy(policyOptions), {
      policy: directoryPolicy,
    });
  };
}
