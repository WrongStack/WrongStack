import { type FSWatcher, watch } from 'node:fs';

interface Listener {
  change: () => void;
  closed: () => void;
}

/** Atomic journal replacements are watched at the directory, never at the inode. */
export class MCPTaskChanges {
  private readonly listeners = new Set<Listener>();
  private watcher?: FSWatcher | undefined;
  private timer?: ReturnType<typeof setTimeout> | undefined;
  private resync?: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly directory: string) {}
  subscribe(change: () => void, closed: () => void): () => void {
    if (this.listeners.size >= 128) throw new Error('Too many MCP task subscriptions');
    const listener = { change, closed };
    this.listeners.add(listener);
    if (!this.resync) {
      this.startWatcher();
      this.resync = setInterval(() => {
        this.stopWatcher();
        this.startWatcher();
        this.invalidate();
      }, 30_000);
      this.resync.unref?.();
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) this.stop();
    };
  }
  private startWatcher(): void {
    try {
      const watcher = watch(this.directory, (_event, file) => {
        if (this.watcher !== watcher) return;
        if (!file || String(file) === 'journal.json') this.invalidate();
      });
      this.watcher = watcher;
      watcher.unref();
      watcher.on('error', () => {
        if (this.watcher !== watcher) return;
        this.stopWatcher();
        this.invalidate();
      });
    } catch {
      /* A bounded resync still observes another process if watching fails. */
    }
  }
  invalidate(): void {
    if (!this.listeners.size || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const listener of [...this.listeners]) {
        if (!this.listeners.has(listener)) continue;
        try {
          listener.change();
        } catch {
          /* Observers cannot break journal writers. */
        }
      }
    }, 50);
    this.timer.unref?.();
  }
  private stopWatcher(): void {
    const watcher = this.watcher;
    this.watcher = undefined;
    watcher?.close();
  }
  private stop(): void {
    this.stopWatcher();
    if (this.timer) clearTimeout(this.timer);
    if (this.resync) clearInterval(this.resync);
    this.timer = undefined;
    this.resync = undefined;
  }
  dispose(): void {
    const listeners = [...this.listeners];
    this.listeners.clear();
    this.stop();
    for (const listener of listeners) {
      try {
        listener.closed();
      } catch {
        /* Isolated observer. */
      }
    }
  }
}
