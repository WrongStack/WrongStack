/**
 * `wstack sage doctor [--fix[=<ids>]] [--json]` — SAGE store health report
 * and its named, idempotent repairs, run by the project's SAGE daemon (spawned
 * if it is not running, so the doctor works without an open session), or by
 * WrongMemory when Sage.service.mode selects it.
 */
import { toErrorMessage } from '@wrongstack/core/utils';
import {
  createSageMemoryPortForService,
  formatSageDoctorReport,
  getSageSurface,
  parseDoctorFixArg,
  sageHygieneOptionsFromConfig,
  suggestedDoctorFixes,
} from '@wrongstack/sage';
import type { SubcommandDeps } from '../contracts.js';

export async function runSageDoctorCommand(
  deps: SubcommandDeps,
  fixArg: string | true | undefined,
  json: boolean,
): Promise<number> {
  const out = (text: string) => deps.renderer.write(`${text}\n`);
  let requested: ReturnType<typeof parseDoctorFixArg>;
  try {
    requested = parseDoctorFixArg(fixArg);
  } catch (error) {
    deps.renderer.writeError(toErrorMessage(error));
    return 1;
  }
  // The configured memory service (Sage.service.mode), as the host uses it:
  // in `wrongmemory` mode the report comes from the WrongMemory daemon, and a
  // local store is never created or opened.
  const port = createSageMemoryPortForService({
    projectRoot: deps.projectRoot,
    directory: deps.config.Sage?.storage?.directory,
    service: deps.config.Sage?.service,
  });
  try {
    await port.initialize();
    const surface = getSageSurface(port);
    const hygieneOptions = sageHygieneOptionsFromConfig(deps.config.Sage?.hygiene);
    let report = await surface?.doctor?.({ hygieneOptions });
    // A daemon from an older release answers an op it does not know with no
    // result rather than an error.
    if (!report?.checks) {
      deps.renderer.writeError(
        'The running SAGE daemon predates `doctor`. Close every wstack session for this project so it restarts, then retry.',
      );
      return 1;
    }
    if (requested !== undefined) {
      const fix = requested === 'suggested' ? suggestedDoctorFixes(report) : requested;
      if (fix.length > 0) report = (await surface?.doctor?.({ fix, hygieneOptions })) ?? report;
    }
    out(json ? JSON.stringify(report, null, 2) : formatSageDoctorReport(report));
    return report.checks.some((check) => check.severity === 'error') ? 1 : 0;
  } catch (error) {
    deps.renderer.writeError(`sage doctor failed: ${toErrorMessage(error)}`);
    return 1;
  } finally {
    await port.dispose().catch(() => {});
  }
}
