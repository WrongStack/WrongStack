export interface ToolOverviewMessage {
  toolName?: string | undefined;
  toolInput?: unknown;
  toolResult?: string | undefined;
  toolOutputBytes?: number | undefined;
  toolOutputLines?: number | undefined;
}
