/** Non-secret native cloud routing settings. Browser-safe and shared across surfaces. */
export interface NativeCloudSettings {
  region?: string | undefined;
  project?: string | undefined;
  location?: string | undefined;
  resourceName?: string | undefined;
}
export const CLOUD_FIELDS = ['region', 'project', 'location', 'resourceName'] as const;
export function parseNativeCloudSettings(raw: unknown): NativeCloudSettings {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => !CLOUD_FIELDS.includes(key as (typeof CLOUD_FIELDS)[number]))
  )
    throw new Error('Invalid native cloud settings');
  const result: NativeCloudSettings = {};
  for (const field of CLOUD_FIELDS) {
    const value = (raw as Record<string, unknown>)[field];
    if (value === undefined || value === '') continue;
    if (
      typeof value !== 'string' ||
      value.length > 128 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
    )
      throw new Error(`Invalid cloud ${field}`);
    result[field] = value;
  }
  return result;
}
export function cloudFieldsForProvider(type: string): readonly (typeof CLOUD_FIELDS)[number][] {
  if (type === 'amazon-bedrock') return ['region'];
  if (type === 'google-vertex') return ['project', 'location'];
  if (type === 'azure' || type === 'azure-cognitive-services') return ['resourceName'];
  return [];
}
export function resolveNativeCloudSettings(
  raw: NativeCloudSettings | undefined,
  env: Readonly<Record<string, string | undefined>>,
  type?: string,
): NativeCloudSettings {
  const config = raw === undefined ? {} : parseNativeCloudSettings(raw);
  return {
    region: config.region ?? env['AWS_REGION'],
    project: config.project ?? env['GOOGLE_VERTEX_PROJECT'],
    location: config.location ?? env['GOOGLE_VERTEX_LOCATION'],
    resourceName:
      config.resourceName ??
      env[
        type === 'azure-cognitive-services'
          ? 'AZURE_COGNITIVE_SERVICES_RESOURCE_NAME'
          : 'AZURE_RESOURCE_NAME'
      ],
  };
}
