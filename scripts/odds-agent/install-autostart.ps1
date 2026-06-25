# Installerar Windows-uppgifter som startar Chrome + odds-agent vid inloggning.
#
#   npm run odds:chrome:install
#   .\install-autostart.ps1 -Uninstall
#
# Krav: .env med ODDS_AGENT_TOKEN (for GitHub -> din dator).

param(
  [switch]$Uninstall
)

$AgentDir = $PSScriptRoot
$ChromeTask = "VM2026 Odds Chrome"
$AgentTask = "VM2026 Odds Agent"

function Remove-OddsTask {
  param([string]$Name)
  $existing = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false
    Write-Host "Borttagen: $Name"
  }
}

if ($Uninstall) {
  Remove-OddsTask $ChromeTask
  Remove-OddsTask $AgentTask
  Write-Host "Autostart avinstallerad."
  exit 0
}

$ChromeScript = Join-Path $AgentDir "start-chrome.ps1"
$AgentScript = Join-Path $AgentDir "start-agent.ps1"

if (-not (Test-Path $ChromeScript) -or -not (Test-Path $AgentScript)) {
  Write-Error "Saknar start-skript i $AgentDir"
  exit 1
}

. (Join-Path $AgentDir "odds-chrome-config.ps1")
Write-OddsChromeLauncherVbs -Config (Get-OddsChromeConfig)

$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero)

$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

# Chrome direkt vid inloggning
$ChromeArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ChromeScript`" -Minimized"
$ChromeAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $ChromeArgs
$ChromeTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
Register-ScheduledTask -TaskName $ChromeTask -Action $ChromeAction -Trigger $ChromeTrigger -Settings $Settings -Principal $Principal -Force | Out-Null
Write-Host "Skapad: $ChromeTask (vid inloggning, minimerad)"

# Agent vid inloggning (start-agent.ps1 vantar pa Chrome)
$AgentArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$AgentScript`""
$AgentAction = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $AgentArgs
$AgentTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
Register-ScheduledTask -TaskName $AgentTask -Action $AgentAction -Trigger $AgentTrigger -Settings $Settings -Principal $Principal -Force | Out-Null
Write-Host "Skapad: $AgentTask (vid inloggning)"

Write-Host ""
Write-Host "Klart. Vid nasta inloggning startar Chrome + agent automatiskt."
Write-Host ""
Write-Host "Nasta steg for GitHub-automation:"
Write-Host "  1. Lagg till i .env:  ODDS_AGENT_TOKEN=<langt-slumpvarde>"
Write-Host "  2. Installera Tailscale pa datorn"
Write-Host "  3. Satt ODDS_AGENT_HOST=0.0.0.0 i .env (sa Tailscale nar agenten)"
Write-Host "  4. GitHub repo secrets:"
Write-Host "       ODDS_AGENT_URL  = http://<din-tailscale-ip>:9847"
Write-Host "       ODDS_AGENT_TOKEN = samma som i .env"
Write-Host ""
Write-Host "Testa lokalt:"
Write-Host "  npm run odds:chrome"
Write-Host "  npm run odds:agent:start"
Write-Host "  npm run odds:sync -- --match `"Germany vs Ecuador`""
