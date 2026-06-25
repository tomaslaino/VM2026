# Skapar desktop-genvag som startar odds-Chrome minimerad via dold launcher.
# Genvagen pekar pa VBS (inte chrome.exe direkt) sa Windows faktiskt minimerar.

. "$PSScriptRoot\odds-chrome-config.ps1"
$cfg = Get-OddsChromeConfig

if (-not (Test-Path $cfg.Chrome)) {
  Write-Error "Hittar inte browser: $($cfg.Chrome)"
  exit 1
}

Write-OddsChromeLauncherVbs -Config $cfg

$Desktop = [Environment]::GetFolderPath("Desktop")
$ShortcutPath = Join-Path $Desktop "$($cfg.ShortcutName).lnk"
$Wscript = Join-Path $env:Windir "System32\wscript.exe"

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($ShortcutPath)
$shortcut.TargetPath = $Wscript
$shortcut.Arguments = "//B `"$($cfg.LauncherVbs)`""
$shortcut.WorkingDirectory = $cfg.ScriptDir
$shortcut.IconLocation = $cfg.ShortcutIcon
$shortcut.WindowStyle = 7
$shortcut.Description = "Odds-agent for gravergrav.se - startar minimerad"
$shortcut.Save()

Write-Host "Skapade genvag ($($cfg.BrowserName)):"
Write-Host "  $ShortcutPath"
Write-Host ""
Write-Host "  1. Stang gammal odds-Chrome (Task Manager) om den redan kor"
Write-Host "  2. Dubbelklicka genvagen"
Write-Host "  3. Pin GENVAGEN till taskbar"
Write-Host ""
Write-Host "Chrome ska hamna minimerad i taskbar, inte som stor ruta."
