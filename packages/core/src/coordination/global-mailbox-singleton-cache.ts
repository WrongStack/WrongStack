type DependencyCache<T> = {
  withoutPublisher?: T;
  readonly byPublisher: WeakMap<object, T>;
};

type ProjectCache<T> = {
  readonly withoutEvents: DependencyCache<T>;
  readonly byEvents: WeakMap<object, DependencyCache<T>>;
};

function createDependencyCache<T>(): DependencyCache<T> {
  return { byPublisher: new WeakMap() };
}

const mailboxInstances = new Map<string, ProjectCache<unknown>>();

export function getOrCreateMailboxInstance<T>(
  projectDir: string,
  events: object | undefined,
  publisher: object | undefined,
  create: () => T,
): T {
  let projectCache = mailboxInstances.get(projectDir) as ProjectCache<T> | undefined;
  if (projectCache === undefined) {
    projectCache = {
      withoutEvents: createDependencyCache(),
      byEvents: new WeakMap(),
    };
    mailboxInstances.set(projectDir, projectCache as ProjectCache<unknown>);
  }

  let dependencyCache = projectCache.withoutEvents;
  if (events !== undefined) {
    const existing = projectCache.byEvents.get(events);
    if (existing !== undefined) {
      dependencyCache = existing;
    } else {
      dependencyCache = createDependencyCache();
      projectCache.byEvents.set(events, dependencyCache);
    }
  }

  if (publisher === undefined) {
    dependencyCache.withoutPublisher ??= create();
    return dependencyCache.withoutPublisher;
  }

  const existing = dependencyCache.byPublisher.get(publisher);
  if (existing !== undefined) return existing;
  const mailbox = create();
  dependencyCache.byPublisher.set(publisher, mailbox);
  return mailbox;
}

export function clearMailboxSingletonCache(): void {
  mailboxInstances.clear();
}
