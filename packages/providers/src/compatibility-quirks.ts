/** Wire-level deviations supported by the generic OpenAI-compatible adapter. */
export interface CompatibilityQuirks {
  stripCacheControl?: boolean | undefined;
  systemAsMessage?: boolean | undefined;
  flattenContentToString?: boolean | undefined;
  preserveToolCallIds?: boolean | undefined;
  parallelToolsDisabled?: boolean | undefined;
  /** @deprecated Tool-input repair now runs for every string-based adapter. */
  emptyToolCallContent?: 'null' | 'empty_string' | undefined;
  thinkingParam?: 'zai-glm' | 'kimi-toggle' | 'always-on' | undefined;
  /** Route literal think tags to the thinking channel and drop stray closers. */
  stripThinkTags?: boolean | undefined;
  /**
   * Maximum number of tool definitions the provider accepts in a single
   * request. When set, lower-priority tools are dropped before the request
   * is serialized to the wire format so the provider never receives more
   * tools than it can handle. See {@link filterToolsByMaxCount}.
   */
  maxTools?: number | undefined;
}
