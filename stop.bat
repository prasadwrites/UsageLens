@echo off
REM UsageLens — Stop the server (Windows)

echo Stopping UsageLens server...

where wsl >nul 2>&1
if %ERRORLEVEL% EQU 0 (
    wsl -e bash -lc "pkill -f 'uvicorn backend.server:app' 2>/dev/null && echo Stopped. || echo Server is not running."
) else (
    taskkill /F /IM "uvicorn.exe" >nul 2>&1
    if %ERRORLEVEL% EQU 0 (
        echo Stopped.
    ) else (
        echo Server is not running.
    )
)
