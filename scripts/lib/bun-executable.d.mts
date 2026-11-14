export function resolveBunExecutable(env?: NodeJS.ProcessEnv): string;
export function isBatchShim(executable: string | undefined): boolean;
export function bunSpawnInvocation(
  executable: string,
  args?: readonly string[],
): {
  command: string;
  args: string[];
  options: { shell?: true; windowsHide?: true };
};
