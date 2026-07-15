@echo off
rem ============================================================
rem  Open the PUBLIC platform (double-click me)
rem  The public instance needs no tunnel and no SSH key -
rem  it is on the open internet. The admin console there asks
rem  for the admin password (ask Herman).
rem ============================================================
echo.
echo   [1] Platform        http://43.136.113.129/
echo   [2] Admin console   http://43.136.113.129/admin  (password needed)
echo   [3] Both
echo.
choice /c 123 /n /m "Open which page? [1/2/3]: "
if errorlevel 3 goto both
if errorlevel 2 goto admin
start "" "http://43.136.113.129/"
goto done
:admin
start "" "http://43.136.113.129/admin"
goto done
:both
start "" "http://43.136.113.129/"
start "" "http://43.136.113.129/admin"
:done
