' Startar odds-Chrome minimerad. Skapas av create-shortcut.ps1 / install-autostart.ps1.
Set sh = CreateObject("WScript.Shell")
cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""C:\Users\Benji\ohiggins\scripts\odds-agent\start-chrome.ps1"" -Minimized"
sh.Run cmd, 0, False
