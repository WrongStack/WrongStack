export interface ConversationAppearance {
  showThinkingLogs?: boolean | undefined;
  groupToolCalls?: boolean | undefined;
  autoCollapseInput?: boolean | undefined;
  keyboardShortcuts?: boolean | undefined;
}

export const conversationAppearanceDefaults = {
  showThinkingLogs: true,
  groupToolCalls: true,
  autoCollapseInput: false,
  keyboardShortcuts: true,
} as const;
export type ConversationDisplay = { [K in keyof typeof conversationAppearanceDefaults]: boolean };

export function parseConversationAppearance(
  value: Record<string, unknown>,
): ConversationAppearance {
  const result: ConversationAppearance = {};
  for (const key of Object.keys(conversationAppearanceDefaults) as Array<
    keyof ConversationAppearance
  >)
    if (typeof value[key] === 'boolean') result[key] = value[key];
  return result;
}

/** Existing desktop shortcuts remain enabled until the user chooses otherwise. */
export function conversationDisplay(value: ConversationAppearance = {}): ConversationDisplay {
  const parsed = parseConversationAppearance(value as Record<string, unknown>);
  return {
    showThinkingLogs: parsed.showThinkingLogs ?? true,
    groupToolCalls: parsed.groupToolCalls ?? true,
    autoCollapseInput: parsed.autoCollapseInput ?? false,
    keyboardShortcuts: parsed.keyboardShortcuts ?? true,
  };
}
