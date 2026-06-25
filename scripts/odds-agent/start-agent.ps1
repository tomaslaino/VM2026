# Startar odds-agenten (HTTP-server). Vantar tills Chrome-debug ar tillgangligt.
# Kor vid boot via install-autostart.ps1, eller manuellt:
#   npm run odds:agent:start

$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$EnvFile = Join-Path $RepoRoot ".env"

function Import-DotEnv {
  param([string]$Path)
  if (-not (Test-Path $Path)) { return }
  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    $eq = $line.IndexOf("=")
    if ($eq -lt 1) { return }
    $key = $line.Substring(0, $eq).Trim()
    $val = $line.Substring($eq + 1).Trim()
    if ($val.StartsWith('"') -and $val.EndsWith('"')) { $val = $val.Substring(1, $val.Length - 2) }
    [Environment]::SetEnvironmentVariable($key, $val, "Process")
  }
}

Import-DotEnv $EnvFile

$Port = if ($env:ODDS_CHROME_PORT) { $env:ODDS_CHROME_PORT } else { "9222" }
$ChromeUrl = "http://127.0.0.1:$Port/json/version"

Write-Host "Odds-agent: vantar Chrome pa port $Port..."
for ($i = 0; $i -lt 40; $i++) {
  try {
    Invoke-WebRequest -Uri $ChromeUrl -UseBasicParsing -TimeoutSec 3 | Out-Null
    Write-Host "Chrome OK."
    break
  } catch {
    if ($i -eq 39) {
      Write-Error "Chrome svarar inte pa $ChromeUrl. Starta VM Odds Chrome forst."
      exit 1
    }
    Start-Sleep -Seconds 3
  }
}

if (-not $env:ODDS_AGENT_TOKEN) {
  Write-Warning "ODDS_AGENT_TOKEN saknas i .env – satt ett langt slumpvarde for GitHub-automation."
}

Set-Location $RepoRoot
Write-Host "Startar odds-agent (npm run odds:agent)..."
npm run odds:agent
