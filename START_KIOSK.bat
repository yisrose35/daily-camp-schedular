@echo off
REM ================================================================
REM  CAMPISTRY KIOSK MODE
REM  
REM  Exit: Use the Exit Demo button (password protected)
REM  Emergency exit: Ctrl+Alt+Delete then Task Manager then End Chrome
REM ================================================================
start "" "C:\Program Files (x86)\Google\Chrome\Application\chrome.exe" --kiosk --disable-pinch --overscroll-history-navigation=0 --user-data-dir="%~dp0chrome_kiosk_profile" --app="file:///%~dp0flow.html"
