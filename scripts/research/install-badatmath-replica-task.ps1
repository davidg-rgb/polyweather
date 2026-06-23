<#
.SYNOPSIS
  Register (or remove) the daily Windows Scheduled Task that runs the badatmath-replica
  forward paper-trade (BADATMATH-REPLICA.md). Runs as the current user, Interactive logon
  (no stored password, no elevation), daily at 07:00, and catches up if the PC was off
  (-StartWhenAvailable). The task only fires while you are logged on.

.USAGE
  Install:  powershell -ExecutionPolicy Bypass -File scripts\research\install-badatmath-replica-task.ps1
  Custom time:  ... install-badatmath-replica-task.ps1 -At 08:30
  Remove:   powershell -ExecutionPolicy Bypass -File scripts\research\install-badatmath-replica-task.ps1 -Uninstall
#>
param(
  [string]$At = "07:00",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"
$taskName = "Polyweather badatmath replica forward"
$repo = "D:\Second Brain\03 Projects\Polyweather"
$wrapper = Join-Path $repo "scripts\research\run-badatmath-replica-forward.cmd"

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed scheduled task '$taskName'."
  } else {
    Write-Host "No scheduled task '$taskName' to remove."
  }
  return
}

if (-not (Test-Path $wrapper)) { throw "Wrapper not found: $wrapper" }

$action    = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$wrapper`""
$trigger   = New-ScheduledTaskTrigger -Daily -At $At
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
$settings  = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
  -Principal $principal -Settings $settings -Force -Description `
  "Daily badatmath-replica forward paper-trade (read-only; BADATMATH-REPLICA.md)" | Out-Null

Write-Host "Registered scheduled task '$taskName' - daily at $At (Interactive logon, catches up if missed)."
Write-Host "Remove with: powershell -ExecutionPolicy Bypass -File scripts\research\install-badatmath-replica-task.ps1 -Uninstall"
