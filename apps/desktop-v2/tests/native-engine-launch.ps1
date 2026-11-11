param(
  [Parameter(Mandatory)][string]$Executable,
  [Parameter(Mandatory)][string]$Project,
  [Parameter(Mandatory)][int]$Port,
  [Parameter(Mandatory)][string]$PidFile
)
$ErrorActionPreference = 'Stop'
# Match sessions::hide (CREATE_NO_WINDOW). Bun's windowsHide still lets the
# engine inherit the test controller's console, which Restart Manager can close.
$taskStart = [Diagnostics.ProcessStartInfo]::new()
$taskStart.FileName = $Executable
$taskStart.WorkingDirectory = $Project
$taskStart.UseShellExecute = $false
$taskStart.CreateNoWindow = $true
$taskStart.RedirectStandardOutput = $true
$taskStart.RedirectStandardError = $true
foreach ($taskArgument in @('--host', '127.0.0.1', '--port', [string]$Port)) {
  $taskStart.ArgumentList.Add($taskArgument)
}
$taskEngine = [Diagnostics.Process]::new()
$taskEngine.StartInfo = $taskStart
try {
  if (-not $taskEngine.Start()) { throw 'The fixture engine could not start' }
  [IO.File]::WriteAllText($PidFile, [string]$taskEngine.Id)
  $taskOutput = $taskEngine.StandardOutput.ReadToEndAsync()
  $taskErrors = $taskEngine.StandardError.ReadToEndAsync()
  $taskEngine.WaitForExit()
  [Console]::Out.Write($taskOutput.GetAwaiter().GetResult())
  [Console]::Error.Write($taskErrors.GetAwaiter().GetResult())
  $taskExitCode = $taskEngine.ExitCode
} finally {
  $taskEngine.Dispose()
}
exit $taskExitCode
