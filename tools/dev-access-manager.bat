@echo off
rem ============================================================
rem  Dev-access manager (Herman only - double-click me)
rem  GUI to see / add / remove teammates' dev-tunnel SSH keys.
rem  Needs the admin (ubuntu@server) SSH key on this PC.
rem ============================================================
powershell -NoProfile -Sta -ExecutionPolicy Bypass -File "%~dp0dev-access-manager.ps1"
