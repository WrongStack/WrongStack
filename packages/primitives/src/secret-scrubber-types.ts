export interface SecretScrubber {
  scrub(text: string): string;
  scrubObject<T>(obj: T): T;
  /**
   * Same redaction as {@link scrubObject}, but the result MAY SHARE structure
   * with the input: any subtree that needed no redaction is returned by
   * reference instead of being rebuilt.
   *
   * Only call this on a graph you exclusively own and will not mutate — a
   * freshly `JSON.parse`d journal line, say. On anything still referenced
   * elsewhere (a live conversation message queued for an async write), the
   * shared subtrees would alias state that can still change underneath the
   * consumer; use {@link scrubObject} there.
   *
   * Optional so existing implementations (and the object literals tests hand
   * in) stay valid; callers fall back to {@link scrubObject}.
   */
  scrubObjectShared?<T>(obj: T): T;
}
