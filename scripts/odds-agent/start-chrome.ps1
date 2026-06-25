# Startar Chrome med remote debugging for odds-agenten.
#
#   npm run odds:chrome
#   .\start-chrome.ps1 -Minimized

param(
  [switch]$Minimized
)

. "$PSScriptRoot\odds-chrome-config.ps1"
$cfg = Get-OddsChromeConfig

if (-not (Test-Path $cfg.Chrome)) {
  Write-Error "Hittar inte browser: $($cfg.Chrome)"
  exit 1
}

New-Item -ItemType Directory -Force -Path $cfg.Profile | Out-Null
Write-OddsChromeLauncherVbs -Config $cfg

if (Test-OddsChromeRunning -Config $cfg) {
  if ($Minimized) {
    Hide-OddsChromeWindows -ProfileMarker $cfg.ProfileMarker | Out-Null
    Write-Host "Odds-Chrome kor redan (port $($cfg.Port)) - minimerad."
  } else {
    Write-Host "Odds-Chrome kor redan pa port $($cfg.Port)."
  }
  exit 0
}

$mode = if ($Minimized) { "minimerad" } else { "normal" }
Write-Host ("Startar {0} ({1}, port {2})..." -f $cfg.BrowserName, $mode, $cfg.Port)
if ($cfg.BrowserName -eq "Chrome") {
  Write-Host "Tips: Chrome Canary ger gul ikon + egen taskbar-post."
}

Start-Process -FilePath $cfg.Chrome -ArgumentList (Get-OddsChromeArguments -Config $cfg -Minimized:$Minimized) -WindowStyle Minimized

if ($Minimized) {
  $ok = Wait-And-Hide-OddsChrome -Config $cfg
  if ($ok) {
    Write-Host "Odds-Chrome startad och minimerad."
  } else {
    Write-Warning "Chrome startade men kunde inte bekrafta port $($cfg.Port) - kontrollera manuellt."
  }
} else {
  Write-Host "Odds-Chrome startad."
}

Write-Host ""
Write-Host "Engangsuppgift: stang geo-popup med X (inte Union Jack), Not Now pa notiser."
