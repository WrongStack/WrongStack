/**
 * Per-project Requirements Intake service factory.
 *
 * Both HTTP bring-up paths need the same service instance shape:
 *   - `startHttpServer` (standalone `wstack webui` server), and
 *   - `startStaticServe` (CLI/TUI-hosted WebUI + SimpleUI).
 *
 * Keeping the construction here means a host cannot bring the HTTP server up
 * with the intake routes silently answering 503 because it forgot to build the
 * service — which is exactly what happened to the CLI-hosted WebUI before this
 * module existed.
 */
import { resolveWstackPaths } from '@wrongstack/core/utils';
import {
  AllowAllIntakeAuthorizer,
  RequirementIntakeService,
  RequirementIntakeStore,
} from '@wrongstack/requirement-intake';

/**
 * Build the intake service backed by this project's
 * `~/.wrongstack/projects/<slug>/requirement-intakes` directory.
 *
 * The HTTP token gate is the authorization boundary, so the service itself
 * runs with a permissive authorizer inside it (see requirement-intake-handlers).
 */
export function createProjectIntakeService(opts: {
  projectRoot: string;
  globalRoot: string;
}): RequirementIntakeService {
  return new RequirementIntakeService({
    store: new RequirementIntakeStore({
      baseDir: resolveWstackPaths({
        projectRoot: opts.projectRoot,
        globalRoot: opts.globalRoot,
      }).projectRequirementIntakes,
    }),
    authorizer: new AllowAllIntakeAuthorizer(),
  });
}
