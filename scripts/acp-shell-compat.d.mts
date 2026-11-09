export function rewriteAgentMessage(
  message: unknown,
  shell: string,
  isExecutablePath?: (path: string) => boolean,
): unknown;
export function runProxy(args: string[]): Promise<number>;
