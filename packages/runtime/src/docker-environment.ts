import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  canonicalEnvironmentProfile,
  type EnvironmentImages,
  type EnvironmentProfile,
  type EnvironmentReceipt,
  validateEnvironmentProfile,
} from '@wrongstack/webui-protocol';
import { isCredentialEnvName } from './credential-reference.js';
import type { DockerCommandRunner } from './docker-command-types.js';

const OWNER = 'dev.wrongstack.workspace-owner';
const CACHE = 'dev.wrongstack.cache-scope';
const immutable = /^[a-f0-9]{64}$/;
const imageId = /^sha256:[a-f0-9]{64}$/;
const sha = (text: string) => createHash('sha256').update(text).digest('hex');
export function environmentFingerprint(profile: EnvironmentProfile): string {
  return sha(canonicalEnvironmentProfile(profile));
}
export function validateWorkspaceEnvironment(
  profile: EnvironmentProfile,
  image: string,
  phase: 'candidate' | 'verification',
  images?: EnvironmentImages,
): void {
  validateEnvironmentProfile(profile);
  if (
    profile.image !== image &&
    !(phase === 'verification' && images?.workspace === image && imageId.test(image))
  )
    throw new Error('Environment profile image must match the workspace image');
  if (
    phase === 'verification' &&
    (!images ||
      !imageId.test(images.workspace) ||
      profile.services.some((service) => !imageId.test(images.services[service.name] ?? '')))
  )
    throw new Error('Verification requires captured environment image identities');
  for (const service of profile.services)
    for (const name of service.envNames)
      if (!isCredentialEnvName(name))
        throw new Error(`Service environment variable cannot be forwarded: ${name}`);
}

/** Owns only generated Docker resources. Never accepts host paths or Docker options from a profile. */
export class DockerEnvironment {
  readonly receipt: EnvironmentReceipt;
  private readonly deadline: number;
  private networkId: string | undefined;
  private networkAttempted = false;
  private readonly attempted = new Map<string, string>();
  private readonly temporaryCaches = new Set<string>();
  constructor(
    private readonly profile: EnvironmentProfile,
    private readonly projectRoot: string,
    private readonly id: string,
    private readonly owner: string,
    private readonly runner: DockerCommandRunner,
    private readonly phase: 'candidate' | 'verification',
    private readonly signal?: AbortSignal,
    private readonly images?: EnvironmentImages,
  ) {
    this.deadline = performance.now() + profile.setupTimeoutMs;
    this.receipt = {
      version: 1,
      name: profile.name,
      fingerprint: environmentFingerprint(profile),
      phase,
      status: 'preparing',
      network: null,
      services: [],
      caches: [],
      ports: [],
      setup: [],
    };
  }
  private async run(args: string[], env: Record<string, string> = {}, allowFailure = false) {
    this.signal?.throwIfAborted();
    const remaining = Math.floor(this.deadline - performance.now());
    if (remaining <= 0) throw new Error('Environment setup timed out');
    const result = await this.runner(args, { timeoutMs: remaining, signal: this.signal, env });
    this.signal?.throwIfAborted();
    if (!allowFailure && result.code !== 0)
      throw new Error(`Environment command failed (${result.code}): ${result.stderr.slice(-1000)}`);
    return result;
  }
  async provision(): Promise<string[]> {
    const args: string[] = [];
    if (this.profile.services.length || this.profile.ports.length) {
      const name = `wrongstack-env-${this.id}`;
      this.receipt.network = name;
      this.networkAttempted = true;
      const created = await this.run([
        'network',
        'create',
        '--driver',
        'bridge',
        '--label',
        `${OWNER}=${this.owner}`,
        name,
      ]);
      if (!immutable.test(created.stdout.trim()))
        throw new Error('Environment network identity unavailable');
      this.networkId = created.stdout.trim();
      args.push('--network', this.networkId);
    }
    const scope = sha(`${this.projectRoot}\0${this.receipt.fingerprint}`);
    for (const cache of this.profile.caches) {
      const persistent = this.phase === 'candidate';
      const volume = persistent
        ? `wrongstack-cache-${scope.slice(0, 40)}-${cache.name}`
        : `wrongstack-check-cache-${this.id}-${cache.name}`;
      const label = persistent ? `${CACHE}=${scope}` : `${OWNER}=${this.owner}`;
      if (!persistent) this.temporaryCaches.add(volume);
      // Docker create does not change labels on an existing volume. Inspect after creation
      // prevents an existing foreign volume from being silently reused.
      await this.run(['volume', 'create', '--driver', 'local', '--label', label, volume]);
      const probed = await this.run(['volume', 'inspect', '--format', '{{json .}}', volume]);
      const info = JSON.parse(probed.stdout);
      if (
        info.Name !== volume ||
        info.Driver !== 'local' ||
        Object.keys(info.Options ?? {}).length ||
        info.Labels?.[persistent ? CACHE : OWNER] !== (persistent ? scope : this.owner)
      )
        throw new Error('Cache volume ownership or local driver cannot be verified');
      this.receipt.caches.push({ ...cache, volume, persistent });
      args.push('--mount', `type=volume,source=${volume},target=${cache.target},volume-nocopy`);
    }
    for (const service of this.profile.services) {
      const name = `wrongstack-service-${this.id}-${service.name}`;
      this.attempted.set(service.name, name);
      const env = Object.fromEntries(
        service.envNames.map((key) => {
          const value = process.env[key];
          if (value === undefined || !value)
            throw new Error(`Missing service environment reference: ${key}`);
          return [key, value];
        }),
      );
      const created = await this.run(
        [
          'create',
          '--name',
          name,
          '--label',
          `${OWNER}=${this.owner}`,
          '--network',
          this.networkId!,
          '--network-alias',
          service.name,
          '--security-opt',
          'no-new-privileges',
          '--pids-limit',
          '128',
          '--memory',
          '512m',
          '--cpus',
          '1',
          ...service.envNames.flatMap((key) => ['--env', key]),
          this.images?.services[service.name] ?? service.image,
          ...service.command,
        ],
        env,
      );
      const containerId = created.stdout.trim();
      if (!immutable.test(containerId)) throw new Error('Service container identity unavailable');
      this.attempted.set(service.name, containerId);
      const image = (
        await this.run(['inspect', '--format', '{{.Image}}', containerId])
      ).stdout.trim();
      if (!imageId.test(image)) throw new Error('Service image identity unavailable');
      this.receipt.services.push({ name: service.name, imageId: image, containerId });
      await this.run(['start', containerId]);
      for (;;) {
        const healthy = await this.run(['exec', containerId, ...service.healthCommand], {}, true);
        if (healthy.code === 0) break;
        await delay(Math.min(250, Math.max(1, this.deadline - performance.now())), undefined, {
          signal: this.signal,
        });
      }
    }
    if (this.phase === 'candidate')
      for (const port of this.profile.ports) args.push('--publish', `127.0.0.1::${port.port}/tcp`);
    return args;
  }
  async setup(container: string, image: string): Promise<void> {
    this.receipt.imageId = image;
    // Cache paths are under the isolated home, never under the source snapshot.
    if (this.profile.caches.length)
      await this.run([
        'exec',
        '--user',
        '0:0',
        container,
        'chown',
        '-R',
        '--no-dereference',
        '1000:1000',
        ...this.profile.caches.map((cache) => cache.target),
      ]);
    for (const argv of this.profile.setupCommands) {
      const started = performance.now();
      const result = await this.run(
        ['exec', '--workdir', '/workspace', container, ...argv],
        {},
        true,
      );
      const output = result.stdout + result.stderr;
      this.receipt.setup.push({
        argv: [...argv],
        exitCode: result.code,
        durationMs: Math.round(performance.now() - started),
        output: output.slice(0, 32_000),
        outputSha256: sha(output),
      });
      if (result.code !== 0) throw new Error(`Environment setup command failed (${result.code})`);
    }
    if (this.phase === 'candidate' && this.profile.ports.length) {
      const bindings = JSON.parse(
        (await this.run(['inspect', '--format', '{{json .NetworkSettings.Ports}}', container]))
          .stdout,
      );
      for (const port of this.profile.ports) {
        const values = bindings?.[`${port.port}/tcp`];
        if (
          !Array.isArray(values) ||
          values.length !== 1 ||
          values[0]?.HostIp !== '127.0.0.1' ||
          !/^\d+$/.test(values[0]?.HostPort ?? '')
        )
          throw new Error('Preview port binding cannot be verified');
        const hostPort = Number(values[0].HostPort);
        if (!Number.isSafeInteger(hostPort) || hostPort < 1 || hostPort > 65535)
          throw new Error('Invalid preview host port');
        this.receipt.ports.push({ ...port, hostPort });
      }
    }
    this.receipt.status = 'ready';
  }
  /** No cancelled signal: cleanup still probes ownership after an aborted command. */
  async cleanup(mainState: 'removed' | 'retained' | 'unverified'): Promise<boolean> {
    let verified = mainState !== 'unverified';
    for (const [service, target] of this.attempted) {
      // A service that received a credential is removed even when the workspace is kept:
      // its configuration holds the forwarded values.
      const remove =
        mainState === 'removed' ||
        !!this.profile.services.find((item) => item.name === service)?.envNames.length;
      if (!(await stopOrRemoveService(target, this.owner, this.runner, remove))) verified = false;
    }
    if (mainState === 'removed' && this.networkAttempted) {
      try {
        const probe = await this.runner(
          [
            'network',
            'inspect',
            '--format',
            `{{.Id}} {{ index .Labels "${OWNER}" }}`,
            this.networkId ?? this.receipt.network!,
          ],
          { timeoutMs: 10_000 },
        );
        const [id, marker] = probe.stdout.trim().split(/\s+/);
        if (
          probe.code === 0 &&
          immutable.test(id ?? '') &&
          marker === this.owner &&
          (!this.networkId || id === this.networkId)
        ) {
          if ((await this.runner(['network', 'rm', id!], { timeoutMs: 10_000 })).code !== 0)
            verified = false;
        } else verified = false;
      } catch {
        verified = false;
      }
    }
    for (const volume of mainState === 'removed' ? this.temporaryCaches : []) {
      try {
        const probe = await this.runner(
          ['volume', 'inspect', '--format', `{{ index .Labels "${OWNER}" }}`, volume],
          { timeoutMs: 10_000 },
        );
        if (
          probe.code !== 0 ||
          probe.stdout.trim() !== this.owner ||
          (await this.runner(['volume', 'rm', volume], { timeoutMs: 10_000 })).code !== 0
        )
          verified = false;
      } catch {
        verified = false;
      }
    }
    this.receipt.status = verified ? mainState : 'unverified';
    return verified;
  }
}

async function stopOrRemoveService(
  target: string,
  owner: string,
  runner: DockerCommandRunner,
  remove: boolean,
): Promise<boolean> {
  try {
    const probe = await runner(
      ['inspect', '--format', `{{.Id}} {{ index .Config.Labels "${OWNER}" }}`, target],
      { timeoutMs: 10_000 },
    );
    if (probe.code !== 0) return /No such (?:object|container)/i.test(probe.stderr);
    const [id, marker] = probe.stdout.trim().split(/\s+/);
    if (!immutable.test(id ?? '') || marker !== owner || (immutable.test(target) && id !== target))
      return false;
    const result = await runner(
      remove ? ['rm', '--force', '--volumes', id!] : ['stop', '--time', '2', id!],
      { timeoutMs: 15_000 },
    );
    return result.code === 0;
  } catch {
    return false;
  }
}
/**
 * Recovery of a run whose worker died. While its workspace is kept, services are stopped and
 * kept beside it (a service that received a credential is still removed). Once the workspace is
 * gone, nothing can use them: services and the owned network are removed.
 */
export async function stopEnvironmentServices(
  profile: EnvironmentProfile,
  id: string,
  owner: string,
  runner: DockerCommandRunner,
  workspaceKept = true,
): Promise<boolean> {
  validateEnvironmentProfile(profile);
  for (const service of profile.services)
    if (
      !(await stopOrRemoveService(
        `wrongstack-service-${id}-${service.name}`,
        owner,
        runner,
        !workspaceKept || service.envNames.length > 0,
      ))
    )
      return false;
  if (workspaceKept || (!profile.services.length && !profile.ports.length)) return true;
  try {
    const probe = await runner(
      [
        'network',
        'inspect',
        '--format',
        `{{.Id}} {{ index .Labels "${OWNER}" }}`,
        `wrongstack-env-${id}`,
      ],
      { timeoutMs: 10_000 },
    );
    if (probe.code !== 0) return /No such network|not found/i.test(probe.stderr);
    const [networkId, marker] = probe.stdout.trim().split(/\s+/);
    if (!immutable.test(networkId ?? '') || marker !== owner) return false;
    return (await runner(['network', 'rm', networkId!], { timeoutMs: 10_000 })).code === 0;
  } catch {
    return false;
  }
}
