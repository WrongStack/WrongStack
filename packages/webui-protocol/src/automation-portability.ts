import { type AutomationJobInput, editableAutomationJob } from './automation.js';

export { type AutomationTemplate, VERSIONED_AUTOMATION_TEMPLATES } from './automation-templates.js';
export interface PortableAutomation {
  type: 'wrongstack.automation';
  version: 1;
  spec: AutomationJobInput;
}
export function exportAutomationJob(job: AutomationJobInput): PortableAutomation {
  const spec = editableAutomationJob(job);
  spec.credentials = Array.isArray(job.credentials)
    ? job.credentials
        .filter((c): c is NonNullable<typeof c> => Boolean(c) && typeof c === 'object')
        .map(({ profile, provider, keyLabel, envName }) => ({
          profile,
          provider,
          keyLabel,
          envName,
        }))
    : undefined;
  return { type: 'wrongstack.automation', version: 1, spec };
}
/** Transport contains names/references only. Validation and project binding remain server-side. */
export function importAutomationJob(raw: unknown): AutomationJobInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Invalid automation document');
  const doc = raw as Record<string, unknown>;
  if (
    doc['type'] !== 'wrongstack.automation' ||
    doc['version'] !== 1 ||
    Object.keys(doc).some((key) => !['type', 'version', 'spec'].includes(key))
  )
    throw new Error('Unsupported automation document');
  const spec = doc['spec'];
  if (!spec || typeof spec !== 'object' || Array.isArray(spec))
    throw new Error('Invalid automation spec');
  const fields = [
    'name',
    'image',
    'prompt',
    'provider',
    'model',
    'envNames',
    'credentials',
    'yolo',
    'enabled',
    'timeoutMs',
    'maxIterations',
    'verification',
    'environment',
    'intervalMs',
    'schedule',
    'github',
    'template',
  ];
  if (Object.keys(spec).some((key) => !fields.includes(key)))
    throw new Error('Automation document contains unsupported or secret fields');
  const record = spec as Record<string, unknown>;
  if (
    record['credentials'] !== undefined &&
    (!Array.isArray(record['credentials']) ||
      record['credentials'].some(
        (ref) =>
          !ref ||
          typeof ref !== 'object' ||
          Array.isArray(ref) ||
          Object.keys(ref).some(
            (key) => !['profile', 'provider', 'keyLabel', 'envName'].includes(key),
          ),
      ))
  )
    throw new Error('Credential values cannot be imported');
  // Imports need an explicit local review before they can dispatch.
  return { ...(structuredClone(spec) as AutomationJobInput), enabled: false, yolo: false };
}
