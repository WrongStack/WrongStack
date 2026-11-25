import type { AcpRuntimeCommand } from '@wrongstack/contracts/types/acp-runtime';

export function advertisedNativeCommand(
  text: string,
  commands: readonly AcpRuntimeCommand[],
): AcpRuntimeCommand | undefined {
  const name = /^\/([^\s/\p{Cc}]+)(?=\s|$)/u.exec(text)?.[1];
  return name ? commands.find((command) => command.name === name) : undefined;
}
