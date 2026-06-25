# Delad konfiguration for odds-agent Chrome (start-chrome.ps1 + create-shortcut.ps1).
# Foredrar Chrome Canary (gul ikon, egen taskbar) om den ar installerad.

function Find-OddsBrowser {
  $candidates = @(
    @{
      Path = Join-Path $env:LOCALAPPDATA "Google\Chrome SxS\Application\chrome.exe"
      Name = "Chrome Canary"
    },
    @{
      Path = "C:\Program Files\Google\Chrome\Application\chrome.exe"
      Name = "Chrome"
    }
  )
  foreach ($c in $candidates) {
    if (Test-Path $c.Path) {
      $icon = if ($c.Name -eq "Chrome Canary") { "$($c.Path),0" } else { "$env:SystemRoot\System32\imageres.dll,104" }
      return [PSCustomObject]@{
        Path = $c.Path
        Name = $c.Name
        Icon = $icon
      }
    }
  }
  return $null
}

function Get-OddsChromeConfig {
  $ScriptDir = $PSScriptRoot
  $browser = Find-OddsBrowser
  if (-not $browser) {
    throw "Hittar varken Chrome Canary eller Chrome."
  }
  $Profile = Join-Path $ScriptDir ".chrome-odds"
  $Port = if ($env:ODDS_CHROME_PORT) { $env:ODDS_CHROME_PORT } else { "9222" }
  $StartUrl = "https://www.oddschecker.com/football/world-cup"
  $ProfileMarker = ".chrome-odds"

  return [PSCustomObject]@{
    ScriptDir       = $ScriptDir
    Chrome          = $browser.Path
    BrowserName     = $browser.Name
    Profile         = $Profile
    ProfileMarker   = $ProfileMarker
    Port            = $Port
    StartUrl        = $StartUrl
    ShortcutIcon    = $browser.Icon
    ShortcutName    = "VM Odds Chrome"
    LauncherVbs     = Join-Path $ScriptDir "launch-odds-chrome.vbs"
  }
}

function Get-OddsChromeArguments {
  param(
    [Parameter(Mandatory = $true)]
    $Config,
    [switch]$Minimized
  )

  $args = @(
    "--remote-debugging-port=$($Config.Port)",
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    "--user-data-dir=$($Config.Profile)",
    "--no-first-run",
    "--disable-session-crashed-bubble"
  )
  if ($Minimized) {
    $args += @(
      "--start-minimized",
      "--window-position=-32000,-32000",
      "--window-size=480,360"
    )
  }
  $args += $Config.StartUrl
  return $args
}

function Get-OddsChromeCommandLine {
  param(
    [Parameter(Mandatory = $true)]
    $Config,
    [switch]$Minimized
  )
  $parts = @('"' + $Config.Chrome + '"') + (Get-OddsChromeArguments -Config $Config -Minimized:$Minimized)
  return ($parts -join " ")
}

function Hide-OddsChromeWindows {
  param(
    [string]$ProfileMarker = ".chrome-odds"
  )

  if (-not ("Win32Odds" -as [type])) {
    Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32Odds {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  public static void MinimizePid(uint pid) {
    EnumWindows((hWnd, lParam) => {
      uint wpid;
      GetWindowThreadProcessId(hWnd, out wpid);
      if (wpid == pid && IsWindowVisible(hWnd)) ShowWindow(hWnd, 6);
      return true;
    }, IntPtr.Zero);
  }
}
"@
  }

  $pids = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like "*$ProfileMarker*" } |
    Select-Object -ExpandProperty ProcessId -Unique

  foreach ($procId in $pids) {
    [Win32Odds]::MinimizePid([uint32]$procId)
  }
  return @($pids).Count
}

function Wait-And-Hide-OddsChrome {
  param(
    [Parameter(Mandatory = $true)]
    $Config,
    [int]$Seconds = 25
  )

  $deadline = (Get-Date).AddSeconds($Seconds)
  while ((Get-Date) -lt $deadline) {
    Hide-OddsChromeWindows -ProfileMarker $Config.ProfileMarker | Out-Null
    try {
      Invoke-WebRequest -Uri "http://127.0.0.1:$($Config.Port)/json/version" -UseBasicParsing -TimeoutSec 2 | Out-Null
      Hide-OddsChromeWindows -ProfileMarker $Config.ProfileMarker | Out-Null
      return $true
    } catch {
      Start-Sleep -Milliseconds 400
    }
  }
  return $false
}

function Write-OddsChromeLauncherVbs {
  param([Parameter(Mandatory = $true)] $Config)

  $ps1 = Join-Path $Config.ScriptDir "start-chrome.ps1"
  $content = @"
' Startar odds-Chrome minimerad. Skapas av create-shortcut.ps1 / install-autostart.ps1.
Set sh = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""$ps1"" -Minimized"
sh.Run cmd, 0, False
"@
  Set-Content -Path $Config.LauncherVbs -Value $content -Encoding ASCII
}

function Test-OddsChromeRunning {
  param([Parameter(Mandatory = $true)] $Config)
  try {
    Invoke-WebRequest -Uri "http://127.0.0.1:$($Config.Port)/json/version" -UseBasicParsing -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}
