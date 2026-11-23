/** Shell targeted by the portable `bash` tool. */
export type EffectiveShell = 'pwsh' | 'powershell' | 'cmd' | 'posix';

/** Resolve the shell pinned by host boot, with cmd as the Windows fallback. */
export function effectiveShell(
  platform: NodeJS.Platform,
  wrongstackShell: string | undefined,
): EffectiveShell {
  if (platform !== 'win32') return 'posix';
  const value = wrongstackShell?.trim().toLowerCase();
  if (value === 'powershell' || value === 'powershell.exe') return 'powershell';
  if (value === 'pwsh' || value === 'pwsh.exe') return 'pwsh';
  return 'cmd';
}
