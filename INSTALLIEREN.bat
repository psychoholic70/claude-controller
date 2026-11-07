@echo off
chcp 65001 >nul
title Claude Controller installieren
set "ZIEL=%USERPROFILE%\.codex\skills\claude-controller"

echo.
echo  Claude Controller wird fuer Codex installiert ...
echo.

where node >nul 2>&1
if errorlevel 1 (
  echo  FEHLT: Node.js. Bitte zuerst von https://nodejs.org installieren, dann diese Datei nochmal starten.
  pause
  exit /b 1
)

if exist "%ZIEL%" rmdir /s /q "%ZIEL%"
mkdir "%ZIEL%"
xcopy "%~dp0*" "%ZIEL%\" /E /I /Y /Q >nul
if errorlevel 1 (
  echo  Kopieren hat nicht geklappt.
  pause
  exit /b 1
)
echo  [OK] Skill liegt jetzt in: %ZIEL%
echo.

where claude >nul 2>&1
if errorlevel 1 (
  echo  FEHLT: Claude Code. Bitte einmal ausfuehren:
  echo      npm install -g @anthropic-ai/claude-code
  echo  und danach diese Datei nochmal starten.
  pause
  exit /b 1
)

node "%ZIEL%\scripts\claude-bridge.mjs" setup | findstr /C:"NOT signed in" >nul
if not errorlevel 1 (
  echo  Du bist bei Claude noch nicht angemeldet. Das geht nur mit dir persoenlich.
  choice /C JN /M "  Jetzt anmelden (es oeffnet sich der Browser)"
  if not errorlevel 2 call claude auth login
)

echo.
node "%ZIEL%\scripts\claude-bridge.mjs" setup
echo.
echo  FERTIG. Oeffne Codex in deinem Projekt und schreibe:
echo      $claude-controller  Pruefe mein Projekt und sag mir, ob es fertig ist.
echo.
pause
