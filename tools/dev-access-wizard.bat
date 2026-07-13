@echo off
rem ============================================================
rem  Dev-instance access wizard (double-click me)
rem  Guides you through one-time SSH setup, then opens a secure
rem  tunnel to the DEV platform and launches it in your browser.
rem ============================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0dev-access-wizard.ps1"
pause
