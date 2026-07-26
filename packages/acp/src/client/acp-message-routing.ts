export function isBestEffortAckMethod(method: string | undefined): boolean {
  return (
    method === 'mcp/connect' ||
    method === 'mcp/message' ||
    method === 'mcp/disconnect' ||
    method === 'elicitation/create' ||
    method === 'elicitation/complete'
  );
}
