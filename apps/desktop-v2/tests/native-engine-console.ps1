param([Parameter(Mandatory)][uint32]$EnginePid)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class FixtureEngineConsole {
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint id);
  [DllImport("kernel32.dll", SetLastError=true)] public static extern uint GetConsoleProcessList([Out] uint[] items, uint count);
}
'@
[FixtureEngineConsole]::FreeConsole() | Out-Null
$taskAttached = [FixtureEngineConsole]::AttachConsole($EnginePid)
$taskError = if ($taskAttached) { 0 } else { [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
$taskItems = @()
if ($taskAttached) {
  $taskBuffer = New-Object uint32[] 1024
  $taskCount = [FixtureEngineConsole]::GetConsoleProcessList($taskBuffer, $taskBuffer.Length)
  $taskItems = @($taskBuffer | Select-Object -First $taskCount)
  [FixtureEngineConsole]::FreeConsole() | Out-Null
}
[pscustomobject]@{attached=$taskAttached;error=$taskError;consolePids=$taskItems} | ConvertTo-Json -Compress
