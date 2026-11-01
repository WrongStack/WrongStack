/**
 * The machines HQ has seen, remembered across disconnects and restarts.
 *
 * The live snapshot only knows machines with a connected client, so a box that
 * drops off simply vanished from the dashboard: the operator could not tell
 * "LAB-02 went quiet two hours ago" from "LAB-02 never existed". The roster
 * folds every snapshot into `machines.json` and hands back the ones that are
 * known but not connected.
 *
 * Every field comes from CLIENT data (hostnames, versions, project names), so
 * strings are clipped, the file is re-validated on load, and the roster is
 * bounded — a client inventing hostnames cannot grow it without limit.
 *
 * @module hq/persistence/machine-roster
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { atomicWrite } from '@wrongstack/core/utils';
import type { HqKnownMachine, HqSnapshot } from '../protocol.js';
import { BestEffortLatestQueue } from '../write-queues.js';

/** Forget a machine nobody has seen for this long. */
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_MACHINES = 500;
/** A live machine's last-seen only needs rewriting to disk this often. */
const LAST_SEEN_PERSIST_MS = 60_000;
const MAX_PROJECTS_PER_MACHINE = 20;
const MAX_IDS_PER_MACHINE = 20;
const MAX_TEXT = 255;

/**
 * The machine key the snapshot groups by: the hostname when known, so every
 * process on one computer is one machine, else the reported machine id.
 */
export function hqMachineKey(hostname: string | undefined, machineId: string | undefined): string {
  const hn = hostname?.trim();
  return hn ? `host:${hn.toLowerCase()}` : `mid:${machineId || 'local'}`;
}

export interface HqMachineRosterOptions {
  dataDir: string;
  retentionMs?: number;
  maxMachines?: number;
}

function clip(value: string): string {
  return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
}

function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

/** One stored entry, or null when the file holds something else. */
function parseEntry(raw: unknown): HqKnownMachine | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  const firstSeenAt = isoOrNull(entry.firstSeenAt);
  const lastSeenAt = isoOrNull(entry.lastSeenAt);
  if (typeof entry.key !== 'string' || !/^(host|mid):/.test(entry.key)) return null;
  if (firstSeenAt === null || lastSeenAt === null) return null;
  const machineIds = Array.isArray(entry.machineIds)
    ? entry.machineIds.filter((id): id is string => typeof id === 'string').map(clip)
    : [];
  const projects = Array.isArray(entry.projects)
    ? entry.projects.flatMap((project: unknown) => {
        if (typeof project !== 'object' || project === null) return [];
        const { projectId, projectName } = project as Record<string, unknown>;
        if (typeof projectId !== 'string') return [];
        return [
          {
            projectId: clip(projectId),
            projectName: clip(typeof projectName === 'string' ? projectName : projectId),
          },
        ];
      })
    : [];
  return {
    key: clip(entry.key),
    ...(typeof entry.hostname === 'string' ? { hostname: clip(entry.hostname) } : {}),
    machineIds: machineIds.slice(0, MAX_IDS_PER_MACHINE),
    projects: projects.slice(0, MAX_PROJECTS_PER_MACHINE),
    ...(typeof entry.lastVersion === 'string' ? { lastVersion: clip(entry.lastVersion) } : {}),
    firstSeenAt,
    lastSeenAt,
  };
}

/** What a live snapshot says about one machine. */
interface Sighting {
  hostname: string | undefined;
  machineIds: Set<string>;
  projectIds: Set<string>;
  version: { value: string; seenAt: string } | undefined;
}

function sightingsOf(snapshot: HqSnapshot): Map<string, Sighting> {
  // A record without a hostname borrows it from another record with the same
  // raw machine id, so it lands on its real computer, not a phantom `mid:` one.
  const hostById = new Map<string, string>();
  const records = [
    ...(snapshot.machines ?? []),
    ...snapshot.clients,
    ...(snapshot.liveSessions ?? []),
  ];
  for (const record of records) {
    if (record.machineId && record.hostname?.trim())
      hostById.set(record.machineId, record.hostname);
  }
  const keyOf = (hostname: string | undefined, machineId: string | undefined): string =>
    hqMachineKey(
      hostname?.trim() ? hostname : machineId ? hostById.get(machineId) : undefined,
      machineId,
    );

  const sightings = new Map<string, Sighting>();
  const sight = (hostname: string | undefined, machineId: string | undefined): Sighting => {
    const key = keyOf(hostname, machineId);
    let sighting = sightings.get(key);
    if (sighting === undefined) {
      sighting = {
        hostname: undefined,
        machineIds: new Set(),
        projectIds: new Set(),
        version: undefined,
      };
      sightings.set(key, sighting);
    }
    const host = hostname?.trim() ? hostname : machineId ? hostById.get(machineId) : undefined;
    if (host !== undefined) sighting.hostname ??= host;
    if (machineId) sighting.machineIds.add(machineId);
    return sighting;
  };
  for (const machine of snapshot.machines ?? []) {
    const sighting = sight(machine.hostname, machine.machineId);
    for (const projectId of machine.projectIds) sighting.projectIds.add(projectId);
  }
  for (const client of snapshot.clients) {
    if (!client.connected) continue;
    const sighting = sight(client.hostname, client.machineId);
    sighting.projectIds.add(client.projectId);
    if (
      client.version !== undefined &&
      (sighting.version === undefined || client.lastSeenAt > sighting.version.seenAt)
    ) {
      sighting.version = { value: client.version, seenAt: client.lastSeenAt };
    }
  }
  return sightings;
}

export class HqMachineRoster {
  private readonly filePath: string;
  private readonly retentionMs: number;
  private readonly maxMachines: number;
  private readonly machines = new Map<string, HqKnownMachine>();
  private readonly writer: BestEffortLatestQueue<string>;
  /** Keys connected at the last observation. */
  private live = new Set<string>();
  private lastPersistAt = 0;
  /**
   * `loading` holds writes back: an observation made while the file is still
   * being read would otherwise overwrite it with an empty roster.
   */
  private loadState: 'idle' | 'loading' | 'done' = 'idle';
  private persistAfterLoad = false;

  constructor(opts: HqMachineRosterOptions) {
    this.filePath = path.join(opts.dataDir, 'machines.json');
    this.retentionMs = opts.retentionMs ?? DEFAULT_RETENTION_MS;
    this.maxMachines = opts.maxMachines ?? DEFAULT_MAX_MACHINES;
    this.writer = new BestEffortLatestQueue((json) =>
      atomicWrite(this.filePath, json, { mode: 0o600 }),
    );
  }

  /** Seed from disk. A missing or corrupt file leaves the roster empty. */
  async load(now: number = Date.now()): Promise<void> {
    this.loadState = 'loading';
    try {
      await this.loadFile(now);
    } finally {
      this.loadState = 'done';
      if (this.persistAfterLoad) {
        this.persistAfterLoad = false;
        this.persist(now);
      }
    }
  }

  private async loadFile(now: number): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
    } catch {
      return;
    }
    const entries = Array.isArray((raw as { machines?: unknown })?.machines)
      ? ((raw as { machines: unknown[] }).machines ?? [])
      : [];
    for (const candidate of entries) {
      const entry = parseEntry(candidate);
      if (entry === null || this.expired(entry, now)) continue;
      // An observation made before the load finished is newer: keep it.
      if (!this.machines.has(entry.key)) this.machines.set(entry.key, entry);
    }
    this.enforceCap();
  }

  /** Fold a live snapshot in. Persists when something material changed. */
  observe(snapshot: HqSnapshot, now: number = Date.now()): void {
    const seenAt = isoOrNull(snapshot.generatedAt) ?? new Date(now).toISOString();
    const projectName = (id: string): string =>
      snapshot.projects.find((project) => project.projectId === id)?.projectName ?? id;
    const sightings = sightingsOf(snapshot);
    let material = false;
    for (const [key, sighting] of sightings) {
      const previous = this.machines.get(key);
      const projects = new Map(
        (previous?.projects ?? []).map((project) => [project.projectId, project.projectName]),
      );
      for (const projectId of sighting.projectIds) {
        projects.delete(projectId);
        projects.set(projectId, projectName(projectId));
      }
      const machineIds = new Set([...(previous?.machineIds ?? []), ...sighting.machineIds]);
      const hostname = sighting.hostname ?? previous?.hostname;
      const lastVersion = sighting.version?.value ?? previous?.lastVersion;
      const next: HqKnownMachine = {
        key,
        ...(hostname !== undefined ? { hostname: clip(hostname) } : {}),
        machineIds: [...machineIds].map(clip).slice(-MAX_IDS_PER_MACHINE),
        // Newest last, so the slice keeps the projects seen most recently.
        projects: [...projects]
          .map(([projectId, name]) => ({ projectId: clip(projectId), projectName: clip(name) }))
          .slice(-MAX_PROJECTS_PER_MACHINE),
        ...(lastVersion !== undefined ? { lastVersion: clip(lastVersion) } : {}),
        firstSeenAt: previous?.firstSeenAt ?? seenAt,
        lastSeenAt:
          previous !== undefined && previous.lastSeenAt > seenAt ? previous.lastSeenAt : seenAt,
      };
      if (
        previous === undefined ||
        previous.hostname !== next.hostname ||
        previous.lastVersion !== next.lastVersion ||
        previous.machineIds.length !== next.machineIds.length ||
        previous.projects.length !== next.projects.length ||
        previous.projects.some((project, i) => project.projectId !== next.projects[i]?.projectId)
      ) {
        material = true;
      }
      this.machines.set(key, next);
    }
    const live = new Set(sightings.keys());
    if (live.size !== this.live.size || [...live].some((key) => !this.live.has(key))) {
      material = true;
    }
    this.live = live;
    for (const [key, entry] of this.machines) {
      if (!live.has(key) && this.expired(entry, now)) {
        this.machines.delete(key);
        material = true;
      }
    }
    if (this.enforceCap()) material = true;
    if (material || now - this.lastPersistAt >= LAST_SEEN_PERSIST_MS) this.persist(now);
  }

  /** Known machines with no connected client, most recently seen first. */
  offline(now: number = Date.now()): HqKnownMachine[] {
    return [...this.machines.values()]
      .filter((entry) => !this.live.has(entry.key) && !this.expired(entry, now))
      .sort((a, b) => Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt));
  }

  /** Keys connected at the last observation. */
  liveKeys(): ReadonlySet<string> {
    return this.live;
  }

  /** Is this key connected right now (as of the last observation)? */
  isLive(key: string): boolean {
    return this.live.has(key);
  }

  /**
   * Drop an offline machine. A connected one is refused: it would be
   * re-learned on the next snapshot, so forgetting it would only pretend.
   */
  forget(key: string, now: number = Date.now()): 'forgotten' | 'live' | 'unknown' {
    if (this.live.has(key)) return 'live';
    if (!this.machines.delete(key)) return 'unknown';
    this.persist(now);
    return 'forgotten';
  }

  /** Resolves once queued writes settled. For tests and shutdown. */
  async drain(): Promise<void> {
    await this.writer.drain();
  }

  private expired(entry: HqKnownMachine, now: number): boolean {
    return now - Date.parse(entry.lastSeenAt) > this.retentionMs;
  }

  /** Evict the longest-unseen offline machines past the cap. */
  private enforceCap(): boolean {
    if (this.machines.size <= this.maxMachines) return false;
    const evictable = [...this.machines.values()]
      .filter((entry) => !this.live.has(entry.key))
      .sort((a, b) => Date.parse(a.lastSeenAt) - Date.parse(b.lastSeenAt));
    for (const entry of evictable) {
      if (this.machines.size <= this.maxMachines) break;
      this.machines.delete(entry.key);
    }
    return true;
  }

  private persist(now: number): void {
    if (this.loadState === 'loading') {
      this.persistAfterLoad = true;
      return;
    }
    this.lastPersistAt = now;
    this.writer.enqueue(JSON.stringify({ version: 1, machines: [...this.machines.values()] }));
  }
}
