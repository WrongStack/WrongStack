import type { ProviderConfig } from '@wrongstack/contracts/types';
import { resolveNativeCloudSettings } from '@wrongstack/core/cloud-provider';
import { endpointCredentialsSuppressed } from './endpoint-credentials.js';

export interface ProviderPreflightCheck {
  name: string;
  status: 'configured' | 'missing' | 'unverified';
  hint: string;
}
export interface ProviderPreflight {
  providerId: string;
  native: boolean;
  checks: ProviderPreflightCheck[];
  requiresConfiguration: boolean;
}

/** Setup diagnostics only: presence is never reported as authenticated account access. */
export function inspectProviderPreflight(
  providerId: string,
  config: ProviderConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProviderPreflight {
  const checks: ProviderPreflightCheck[] = [];
  const add = (name: string, configured: boolean, hint: string) =>
    checks.push({ name, status: configured ? 'configured' : 'missing', hint });
  const explicitKey = Boolean(
    config.apiKeys?.find((key) => key.label === config.activeKey)?.apiKey ??
      config.apiKeys?.[0]?.apiKey ??
      config.apiKey,
  );
  const supported = ['amazon-bedrock', 'google-vertex', 'azure', 'azure-cognitive-services'];
  const id = supported.includes(config.type) ? config.type : providerId;
  if (supported.includes(id) && endpointCredentialsSuppressed(config) && !explicitKey) {
    return {
      providerId,
      native: true,
      checks: [
        {
          name: 'credential',
          status: 'missing',
          hint: 'This endpoint suppresses inherited credentials. Configure an explicit provider API key.',
        },
      ],
      requiresConfiguration: true,
    };
  }
  const cloud = resolveNativeCloudSettings(config.cloud, env, id);
  if (id === 'amazon-bedrock') {
    if (config.baseUrl && (explicitKey || env['AWS_BEARER_TOKEN_BEDROCK']) && !cloud.region)
      checks.push({
        name: 'region',
        status: 'unverified',
        hint: 'The custom API-key endpoint selects its own region; verify it with a live test.',
      });
    else
      add(
        'region',
        Boolean(cloud.region),
        'Set provider cloud.region or AWS_REGION for the native SDK route; AWS_DEFAULT_REGION alone is not read by this adapter.',
      );
    if (explicitKey || env['AWS_BEARER_TOKEN_BEDROCK'])
      add(
        'credential',
        true,
        'An explicit Bedrock API credential is configured; account/model access still needs a live test.',
      );
    else if (env['AWS_ACCESS_KEY_ID'] || env['AWS_SECRET_ACCESS_KEY'])
      add(
        'credential pair',
        Boolean(env['AWS_ACCESS_KEY_ID'] && env['AWS_SECRET_ACCESS_KEY']),
        'Set both AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY; temporary credentials may also need AWS_SESSION_TOKEN.',
      );
    else
      checks.push({
        name: 'AWS credential chain',
        status: 'unverified',
        hint: 'The native SDK may use AWS_PROFILE, shared credentials, SSO or a role. Presence and account/model access require SDK resolution or a live test.',
      });
  } else if (id === 'google-vertex') {
    const express = explicitKey || env['GOOGLE_VERTEX_API_KEY'];
    for (const [name, variable] of [
      ['project', 'GOOGLE_VERTEX_PROJECT'],
      ['location', 'GOOGLE_VERTEX_LOCATION'],
    ] as const) {
      if (express && !cloud[name])
        checks.push({
          name,
          status: 'unverified',
          hint: `${variable} is optional for Gemini Express API-key routing but may be needed for a partner-model route. Verify the selected model.`,
        });
      else
        add(
          name,
          Boolean(cloud[name]),
          `Set provider cloud.${name} or ${variable} for the native Vertex ADC route.`,
        );
    }
    if (explicitKey || env['GOOGLE_VERTEX_API_KEY'])
      add(
        'credential',
        true,
        'A Vertex API credential is configured; account/model access still needs a live test.',
      );
    else
      checks.push({
        name: 'Google application credentials',
        status: 'unverified',
        hint: 'The native SDK uses Application Default Credentials. GOOGLE_APPLICATION_CREDENTIALS names a file; it is not an API key. Run a live modeldiag test to verify access.',
      });
  } else if (id === 'azure' || id === 'azure-cognitive-services') {
    const cognitive = id === 'azure-cognitive-services';
    add(
      'endpoint',
      Boolean(config.baseUrl || cloud.resourceName),
      'Set provider cloud.resourceName, baseUrl or its Azure resource environment variable.',
    );
    add(
      'credential',
      Boolean(explicitKey || env[cognitive ? 'AZURE_COGNITIVE_SERVICES_API_KEY' : 'AZURE_API_KEY']),
      'This native route requires an API key. A configured endpoint alone does not authorize access.',
    );
  } else return { providerId, native: false, checks: [], requiresConfiguration: false };
  return {
    providerId,
    native: true,
    checks,
    requiresConfiguration: checks.some((check) => check.status === 'missing'),
  };
}
