/** Portable, operator-authored environment settings. Only references to host environment values. */
export interface EnvironmentProfile {
  version: 1;
  name: string;
  image: string;
  setupCommands: string[][];
  setupTimeoutMs: number;
  services: Array<{
    name: string;
    image: string;
    command: string[];
    healthCommand: string[];
    envNames: string[];
  }>;
  caches: Array<{ name: string; target: string }>;
  ports: Array<{ name: string; port: number; protocol: 'http' | 'tcp' }>;
}
export interface EnvironmentReceipt {
  failure?: string | undefined;
  version: 1;
  name: string;
  fingerprint: string;
  phase: 'candidate' | 'verification';
  status: 'preparing' | 'ready' | 'removed' | 'retained' | 'unverified';
  imageId?: string | undefined;
  network: string | null;
  services: Array<{ name: string; imageId: string; containerId: string }>;
  caches: Array<{ name: string; target: string; volume: string | null; persistent: boolean }>;
  ports: Array<{ name: string; port: number; protocol: 'http' | 'tcp'; hostPort: number }>;
  setup: Array<{
    argv: string[];
    exitCode: number;
    durationMs: number;
    outputSha256: string;
    output: string;
  }>;
}
export interface EnvironmentImages {
  workspace: string;
  services: Record<string, string>;
}

const identifier = /^[a-z][a-z0-9-]{0,31}$/;
function record(raw: unknown, keys: string[]): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    Object.keys(raw).some((key) => !keys.includes(key))
  )
    throw new Error('Unsupported environment profile field');
  return raw as Record<string, unknown>;
}
function image(value: unknown): void {
  if (
    typeof value !== 'string' ||
    value.length > 256 ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/.test(value) ||
    value.includes('://')
  )
    throw new Error('Select a trusted environment image');
}
function argv(raw: unknown, empty = false): void {
  if (
    !Array.isArray(raw) ||
    (!empty && !raw.length) ||
    raw.length > 64 ||
    raw.some(
      (arg) => typeof arg !== 'string' || arg.length > 8192 || /[\x00-\x1f\x7f]/.test(arg),
    ) ||
    (raw.length && (!raw[0].trim() || raw[0].startsWith('-')))
  )
    throw new Error('Invalid environment command argv');
}
export function validateEnvironmentProfile(raw: unknown): asserts raw is EnvironmentProfile {
  const p = record(raw, [
    'version',
    'name',
    'image',
    'setupCommands',
    'setupTimeoutMs',
    'services',
    'caches',
    'ports',
  ]);
  if (p.version !== 1 || typeof p.name !== 'string' || !identifier.test(p.name))
    throw new Error('Environment requires version 1 and a lowercase profile name');
  image(p.image);
  if (
    !Number.isSafeInteger(p.setupTimeoutMs) ||
    Number(p.setupTimeoutMs) < 1000 ||
    Number(p.setupTimeoutMs) > 3_600_000
  )
    throw new Error('Environment setup timeout must be 1 to 3600 seconds');
  if (!Array.isArray(p.setupCommands) || p.setupCommands.length > 8)
    throw new Error('Environment allows at most eight setup commands');
  for (const command of p.setupCommands) argv(command);
  for (const field of ['services', 'caches', 'ports']) {
    const list = p[field];
    if (!Array.isArray(list) || list.length > 4)
      throw new Error(`Environment allows at most four ${field}`);
  }
  const services = new Set<string>();
  for (const rawService of p.services as unknown[]) {
    const service = record(rawService, ['name', 'image', 'command', 'healthCommand', 'envNames']);
    if (
      typeof service.name !== 'string' ||
      !identifier.test(service.name) ||
      services.has(service.name)
    )
      throw new Error('Service names must be unique lowercase identifiers');
    services.add(service.name);
    image(service.image);
    argv(service.command, true);
    argv(service.healthCommand);
    if (
      !Array.isArray(service.envNames) ||
      service.envNames.length > 16 ||
      service.envNames.some(
        (name) => typeof name !== 'string' || !/^[A-Z_][A-Z0-9_]{0,63}$/.test(name),
      ) ||
      new Set(service.envNames).size !== service.envNames.length
    )
      throw new Error('Services accept environment variable names only');
  }
  const cacheNames = new Set<string>(),
    targets = new Set<string>();
  for (const rawCache of p.caches as unknown[]) {
    const cache = record(rawCache, ['name', 'target']);
    if (
      typeof cache.name !== 'string' ||
      !identifier.test(cache.name) ||
      cacheNames.has(cache.name) ||
      typeof cache.target !== 'string' ||
      targets.has(cache.target) ||
      !/^(?:\/home\/node\/\.cache\/[a-zA-Z0-9_-]+|\/home\/node\/\.bun\/install\/cache)$/.test(
        cache.target,
      )
    )
      throw new Error('Cache targets must be unique package-cache directories under /home/node');
    cacheNames.add(cache.name);
    targets.add(cache.target);
  }
  const portNames = new Set<string>(),
    ports = new Set<number>();
  for (const rawPort of p.ports as unknown[]) {
    const port = record(rawPort, ['name', 'port', 'protocol']);
    if (
      typeof port.name !== 'string' ||
      !identifier.test(port.name) ||
      portNames.has(port.name) ||
      !Number.isSafeInteger(port.port) ||
      Number(port.port) < 1024 ||
      Number(port.port) > 65535 ||
      ports.has(Number(port.port)) ||
      (port.protocol !== 'http' && port.protocol !== 'tcp')
    )
      throw new Error('Ports require unique names and ports 1024 to 65535');
    portNames.add(port.name);
    ports.add(Number(port.port));
  }
  if (
    new TextEncoder().encode(
      JSON.stringify({ type: 'wrongstack.environment', version: 1, profile: raw }, null, 2),
    ).length >
    64 * 1024
  )
    throw new Error('Environment profile exceeds 64 KiB');
}
export function parseEnvironmentProfile(text: string): EnvironmentProfile {
  if (new TextEncoder().encode(text).length > 64 * 1024)
    throw new Error('Environment profile exceeds 64 KiB');
  let doc: unknown;
  try {
    doc = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('Invalid environment profile JSON');
  }
  const wrapper = record(doc, ['type', 'version', 'profile']);
  if (wrapper.type !== 'wrongstack.environment' || wrapper.version !== 1)
    throw new Error('Unsupported environment profile document');
  validateEnvironmentProfile(wrapper.profile);
  return structuredClone(wrapper.profile);
}
export function exportEnvironmentProfile(profile: EnvironmentProfile): string {
  validateEnvironmentProfile(profile);
  return JSON.stringify({ type: 'wrongstack.environment', version: 1, profile }, null, 2);
}
export function canonicalEnvironmentProfile(profile: EnvironmentProfile): string {
  validateEnvironmentProfile(profile);
  return JSON.stringify(profile, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, value[key]]),
        )
      : value,
  );
}
