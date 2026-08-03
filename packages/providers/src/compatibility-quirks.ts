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
  /**
   * Some gateways (OpenCode Go Zen, terse local proxies) close a successful
   * chat-completions SSE stream without a `[DONE]` marker or a final
   * `finish_reason` chunk. When set, a started stream that ends without a
   * terminal marker is treated as cleanly finished — `parseOpenAIStream`
   * synthesizes the terminal `message_stop` instead of raising the retryable
   * 599 `stream_hang` truncation error. Off by default so compliant
   * endpoints still surface genuine mid-stream cuts.
   */
  tolerateMissingTerminalMarker?: boolean | undefined;
}
