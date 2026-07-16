@echo off
rem NOTE: keep this file ASCII-only above the chcp line -- cmd parses
rem batch files with the system codepage, and UTF-8 Chinese here
rem desyncs the parser into executing comment fragments.
rem ============================================================
rem  Peipao companion-agent demo launcher
rem  Starts the zero-dependency demo server and opens the browser.
rem  Requirements: Node.js 18+ on PATH. No npm install needed.
rem
rem  Optional: set provider keys for this window before launching,
rem  or just paste a key into the web UI settings drawer instead.
rem    set MINIMAX_API_KEY=sk-...
rem    set GLM_API_KEY=...
rem    set KIMI_API_KEY=sk-...
rem  Usage: launch-demo.bat [port]   (default 8787)
rem ============================================================
setlocal
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [!] Node.js was not found on PATH. Install Node 18+ from https://nodejs.org
  pause
  exit /b 1
)

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8787"

echo Starting 小小探索家 demo on http://localhost:%PORT% ...
echo （关闭本窗口即停止服务 / close this window to stop the server）

rem Open the browser once the server has had a moment to bind.
start "" cmd /c "timeout /t 2 /nobreak >nul & start "" http://localhost:%PORT%/"

node demo\serve.mjs --port %PORT%
endlocal
