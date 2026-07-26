export interface RegistryHeartbeatEntry {
  lastSeenAt: string;
}

export function pruneStaleRegistryEntries<T extends RegistryHeartbeatEntry>(
  registry: Map<string, T>,
  staleMs: number,
  now = Date.now(),
): void {
  const cutoff = now - staleMs;
  for (const [id, entry] of registry) {
    const lastSeen = Date.parse(entry.lastSeenAt);
    if (!Number.isFinite(lastSeen) || lastSeen < cutoff) {
      registry.delete(id);
    }
  }
}
