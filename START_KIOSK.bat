@echo off
REM ================================================================
REM  CAMPISTRY KIOSK MODE
REM  
REM  Tries Chrome first, falls back to Edge if Chrome not found.
REM  Exit: Use the Exit Demo button (password protected)
REM  Emergency exit: Ctrl+Alt+Delete then Task Manager then End browser
REM ================================================================

REM Try Chrome (x86)
if exist "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" --kiosk --disable-pinch --overscroll-history-navigation=0 --user-data-dir="%~dp0kiosk_profile" --app="file:///%~dp0flow.html"
    goto :EOF
)

REM Try Chrome (64-bit)
if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --kiosk --disable-pinch --overscroll-history-navigation=0 --user-data-dir="%~dp0kiosk_profile" --app="file:///%~dp0flow.html"
    goto :EOF
)

REM Try Chrome (per-user install)
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" (
    start "" "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" --kiosk --disable-pinch --overscroll-history-navigation=0 --user-data-dir="%~dp0kiosk_profile" --app="file:///%~dp0flow.html"
    goto :EOF
)

REM Fall back to Edge
if exist "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" (
    start "" "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --kiosk --disable-pinch --overscroll-history-navigation=0 --user-data-dir="%~dp0kiosk_profile" --app="file:///%~dp0flow.html"
    goto :EOF
)

if exist "C:\Program Files\Microsoft\Edge\Application\msedge.exe" (
    start "" "C:\Program Files\Microsoft\Edge\Application\msedge.exe" --kiosk --disable-pinch --overscroll-history-navigation=0 --user-data-dir="%~dp0kiosk_profile" --app="file:///%~dp0flow.html"
    goto :EOF
)

REM Nothing found
echo ERROR: Neither Chrome nor Edge was found on this computer.
echo Please install Chrome or Edge and try again.
pause
